import { randomUUID } from "node:crypto";
import type { ChatMessage, CharacterProfile, CoreMemory, MemoryEvent, RetrievedDoc } from "../../../common/types";
import { ChatRepository } from "../../db/database";
import { ElasticsearchService } from "../es/elasticsearch-service";
import { DeepSeekService } from "../llm/deepseek-service";

// 每积累多少条情景记忆后触发一次核心记忆提炼
const CORE_MEMORY_CONSOLIDATION_INTERVAL = 5;

/**
 * 记忆服务，负责管理三层记忆体系：
 * - L1 短期工作记忆（对话摘要）
 * - L2 情景记忆（单次交互提炼与检索）
 * - L3 核心记忆（跨会话的用户画像与关系状态）
 */
export class MemoryService {
  /**
   * @param repository - 数据库仓库，用于持久化记忆数据
   * @param elasticsearchService - ES 服务，用于情景记忆与核心记忆的高性能检索
   * @param deepSeekService - 可选的大模型服务，用于记忆提炼与摘要生成
   */
  constructor(
    private readonly repository: ChatRepository,
    private readonly elasticsearchService: ElasticsearchService,
    private readonly deepSeekService?: DeepSeekService,
  ) {}

  // ============ Layer 1: 短期工作记忆 ============

  /**
   * 获取指定会话的当前对话摘要 (L1)。
   *
   * 当提供 characterId 时返回该角色的专属摘要；未提供时返回会话级摘要。
   * 群聊下应传入 characterId 以避免跨角色摘要污染。
   *
   * @param chatId      - 会话 ID
   * @param characterId - 角色 ID，群聊下必传以实现隔离
   * @returns 摘要字符串，若无则返回 undefined
   */
  getSummary(chatId: string, characterId?: string): string | undefined {
    return this.repository.getSummary(chatId, characterId);
  }

  /**
   * 用 LLM 生成真正的对话摘要 (L1)，按角色隔离持久化。
   *
   * 群聊下每个角色拥有独立摘要，避免最后一个写者覆盖其他角色的摘要。
   *
   * @param chatId    - 会话 ID
   * @param character - 角色配置，其 id 作为摘要隔离键
   * @param messages  - 当前对话消息列表
   * @returns 生成的摘要字符串
   */
  async updateSummary(chatId: string, character: CharacterProfile, messages: ChatMessage[]): Promise<string> {
    const recentMessages = messages.slice(-6);
    if (recentMessages.length < 2) {
      const fallback = recentMessages
        .map((m) => `${m.role}${m.roleId ? `(${m.roleId})` : ""}: ${m.content}`)
        .join("\n");
      this.repository.saveSummary(chatId, fallback || "暂无摘要", character.id);
      return fallback || "暂无摘要";
    }

    if (this.deepSeekService) {
      try {
        const messageText = recentMessages
          .map((m) => `${m.role === "user" ? "用户" : character.displayName}: ${m.content.slice(0, 120)}`)
          .join("\n");
        const summary = await this.deepSeekService.generateConversationSummary({
          characterName: character.displayName,
          recentMessages: messageText,
        });
        this.repository.saveSummary(chatId, summary, character.id);
        return summary;
      } catch {
        // LLM 失败时降级到原始方式
      }
    }

    // Fallback: 保留原始方式
    const fallback = recentMessages
      .map((m) => `${m.role}${m.roleId ? `(${m.roleId})` : ""}: ${m.content}`)
      .join("\n");
    this.repository.saveSummary(chatId, fallback || "暂无摘要", character.id);
    return fallback || "暂无摘要";
  }

  // ============ Layer 2: 情景记忆 ============

  /**
   * 检索情景记忆 (L2)：优先 ES，降级到 SQLite
   * @param chatId - 会话 ID
   * @param query - 检索查询文本
   * @param characterId - 可选的角色 ID，用于过滤特定角色的记忆
   * @returns 匹配的检索文档列表
   */
  async recall(chatId: string, query: string, characterId?: string): Promise<RetrievedDoc[]> {
    const esResults = await this.elasticsearchService.searchMemories(query, {
      sessionId: chatId,
      character: characterId,
      topK: 4,
    });
    if (esResults.length > 0) {
      return esResults;
    }
    // ES 降级时返回 SQLite 记忆，按 character 过滤防止串角色
    return this.repository
      .listMemoryEvents(chatId, 6, characterId)
      .filter((event) => !characterId || event.character === characterId)
      .map((event) => ({
        sourceId: event.id,
        recordType: "memory" as const,
        character: event.character,
        text: event.summary || event.content,
        score: (event.importance ?? 3) / 10,
      }));
  }

  /**
   * 用 LLM 提炼情景记忆 (L2) 并持久化到 SQLite 和 ES
   * @param chatId - 会话 ID
   * @param character - 角色配置
   * @param messages - 当前对话消息列表
   * @returns 持久化后的记忆事件，若无法提炼则返回 null
   */
  async extractAndPersist(
    chatId: string,
    character: CharacterProfile,
    messages: ChatMessage[],
  ): Promise<MemoryEvent | null> {
    const latestUser = [...messages].reverse().find((m) => m.role === "user");
    const latestAssistant = [...messages].reverse().find(
      (m) => m.role === "assistant" && m.roleId === character.id,
    );
    if (!latestUser || !latestAssistant) return null;

    // 用 LLM 提炼情景记忆
    let summary = `${character.displayName}记住：用户提到"${latestUser.content.slice(0, 80)}"，回复"${latestAssistant.content.slice(0, 80)}"`;
    let emotion = "平静";
    let importance = 3;
    let keyPoints: string[] = [];

    if (this.deepSeekService) {
      try {
        const extraction = await this.deepSeekService.extractEpisodicMemory({
          characterName: character.displayName,
          userInput: latestUser.content,
          assistantOutput: latestAssistant.content,
        });
        summary = extraction.summary;
        emotion = extraction.emotion;
        importance = extraction.importance;
        keyPoints = extraction.keyPoints;
      } catch {
        // LLM 失败时降级
      }
    }

    const event: MemoryEvent = {
      id: randomUUID(),
      chatId,
      sessionId: chatId,
      character: character.id,
      summary,
      emotion,
      importance,
      keyPoints,
      content: latestAssistant.content,
      category: "interaction",
      timestamp: Date.now(),
      tags: [character.id, "interaction", emotion],
      sourceMessageId: latestAssistant.id,
    };

    this.repository.saveMemory(event);
    try {
      await this.elasticsearchService.indexMemory(event);
    } catch (error) {
      console.warn("[MemoryService] ES 情景记忆索引失败，已降级到 SQLite:", error);
    }

    // 更新 L1 摘要
    await this.updateSummary(chatId, character, messages);

    return event;
  }

  // ============ Layer 3: 核心记忆 ============

  /**
   * 获取当前核心记忆 (L3)
   * @param chatId - 会话 ID
   * @param character - 角色标识
   * @returns 核心记忆对象，若无则返回 undefined
   */
  getCoreMemory(chatId: string, character: string): CoreMemory | undefined {
    return this.repository.getCoreMemory(chatId, character);
  }

  /**
   * 用 LLM 提炼并持久化核心记忆 (L3)
   * 每积累 CORE_MEMORY_CONSOLIDATION_INTERVAL 条情景记忆后调用
   * @param chatId - 会话 ID
   * @param character - 角色配置
   * @param _messages - 当前对话消息列表（预留参数，暂未使用）
   * @returns 提炼后的核心记忆对象，若 LLM 不可用或记忆不足则返回 null
   */
  async consolidateCoreMemory(
    chatId: string,
    character: CharacterProfile,
    _messages: ChatMessage[],
  ): Promise<CoreMemory | null> {
    if (!this.deepSeekService) return null;

    // 取出该角色最近的情景记忆（按 character 过滤，避免群聊下跨角色污染）
    const recentEvents = this.repository.listMemoryEvents(chatId, CORE_MEMORY_CONSOLIDATION_INTERVAL, character.id);
    if (recentEvents.length < 2) return null;

    const currentCore = this.repository.getCoreMemory(chatId, character.id);
    const memoriesText = recentEvents.map((e) => e.summary || e.content);

    try {
      const result = await this.deepSeekService.consolidateCoreMemory({
        characterName: character.displayName,
        currentCore: currentCore
          ? JSON.stringify({ preferences: currentCore.userPreferences, traits: currentCore.userTraits, stage: currentCore.relationshipStage, notes: currentCore.relationshipNotes, facts: currentCore.keyFacts })
          : "暂无核心记忆",
        recentMemories: memoriesText,
      });

      const core: CoreMemory = {
        id: currentCore?.id ?? randomUUID(),
        chatId,
        character: character.id,
        userPreferences: [...new Set([...(currentCore?.userPreferences ?? []), ...result.userPreferences])],
        userTraits: [...new Set([...(currentCore?.userTraits ?? []), ...result.userTraits])],
        relationshipStage: result.relationshipStage || (currentCore?.relationshipStage ?? ""),
        relationshipNotes: [...new Set([...(currentCore?.relationshipNotes ?? []), ...result.relationshipNotes])],
        keyFacts: [...new Set([...(currentCore?.keyFacts ?? []), ...result.keyFacts])],
        lastUpdated: Date.now(),
      };

      this.repository.saveCoreMemory(core);
      try {
        await this.elasticsearchService.indexCoreMemory(core);
      } catch (error) {
        console.warn("[MemoryService] ES 核心记忆索引失败:", error);
      }

      return core;
    } catch {
      return currentCore ?? null;
    }
  }
}
