import { randomUUID } from "node:crypto";
import type { ChatMemorySnapshot, ChatMessage, CharacterProfile, CoreMemory, CoreMemoryCandidate, MemoryEvent, RetrievedDoc } from "../../../common/types";
import { ChatRepository } from "../../db/database";
import { ElasticsearchService } from "../es/elasticsearch-service";
import { LlmService } from "../llm/llm-service";

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
   * @param llmService - 可选的大模型服务，用于记忆提炼与摘要生成
   */
  constructor(
    private readonly repository: ChatRepository,
    private readonly elasticsearchService: ElasticsearchService,
    private readonly llmService?: LlmService,
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
        .map((m) => `${m.role}${m.roleId ? `(${m.roleId})` : ""}: ${m.content.slice(0, 180)}`)
        .join("\n").slice(0, 1200);
      this.repository.saveSummary(chatId, fallback || "暂无摘要", character.id);
      return fallback || "暂无摘要";
    }

    if (this.llmService) {
      try {
        const messageText = recentMessages
          .map((m) => `${m.role === "user" ? "用户" : character.displayName}: ${m.content.slice(0, 120)}`)
          .join("\n");
        const summary = await this.llmService.generateConversationSummary({
          characterName: character.displayName,
          recentMessages: messageText,
        });
        const bounded = summary.slice(0, 1200);
        this.repository.saveSummary(chatId, bounded, character.id);
        return bounded;
      } catch {
        // LLM 失败时降级到原始方式
      }
    }

    // Fallback: 保留原始方式
    const fallback = recentMessages
      .map((m) => `${m.role}${m.roleId ? `(${m.roleId})` : ""}: ${m.content.slice(0, 180)}`)
      .join("\n").slice(0, 1200);
    this.repository.saveSummary(chatId, fallback || "暂无摘要", character.id);
    return fallback || "暂无摘要";
  }

  // ============ Layer 2: 情景记忆 ============

  /**
   * 检索情景记忆 (L2)：优先 ES，降级到 SQLite
   *
   * 注意：降级路径返回的 score 为 importance/10（0-1 范围），
   * 与 ES 返回的 BM25/向量分数量级不同。调用方在混合使用时
   * 不应跨源比较 score，仅作为同源排序参考。
   *
   * @param chatId - 会话 ID
   * @param query - 检索查询文本
   * @param characterId - 可选的角色 ID，用于过滤特定角色的记忆
   * @returns 匹配的检索文档列表
   */
  async recall(chatId: string, query: string, characterId?: string): Promise<RetrievedDoc[]> {
    let esResults: RetrievedDoc[] = [];
    try {
      esResults = await this.elasticsearchService.searchMemories(query, { sessionId: chatId, character: characterId, topK: 4 });
    } catch (error) {
      console.warn("[MemoryService] ES recall failed; using SQLite:", error);
    }
    if (esResults.length > 0) {
      return esResults;
    }
    // ES 降级时返回 SQLite 记忆，按 character 过滤防止串角色
    // score 归一化到 0-1 范围（importance/10），与 ES 降级路径保持一致
    return this.repository
      .listTimelineEvents(chatId, characterId, "confirmed")
      .filter((event) => !characterId || event.character === characterId)
      .slice(-6).reverse()
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
    // 从后向前遍历一次，同时取出最新的用户消息和该角色的最新助手消息
    let latestUser: ChatMessage | undefined;
    let latestAssistant: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!latestUser && msg.role === "user") {
        latestUser = msg;
      }
      if (!latestAssistant && msg.role === "assistant" && msg.roleId === character.id) {
        latestAssistant = msg;
      }
      if (latestUser && latestAssistant) break;
    }
    if (!latestUser || !latestAssistant) return null;

    if (!this.llmService) { await this.updateSummary(chatId, character, messages); return null; }
    let extraction: Awaited<ReturnType<LlmService["extractEpisodicMemory"]>>;
    try {
      extraction = await this.llmService.extractEpisodicMemory({ characterName: character.displayName, userInput: latestUser.content, assistantOutput: latestAssistant.content });
    } catch { await this.updateSummary(chatId, character, messages); return null; }
    const importance = Math.max(1, Math.min(10, Math.round(extraction.importance)));
    const summary = extraction.summary.trim().slice(0, 160);
    const keyPoints = extraction.keyPoints.map((point) => point.trim().slice(0, 80)).filter(Boolean).slice(0, 5);
    if (!extraction.shouldRemember || importance < 7 || !summary) { await this.updateSummary(chatId, character, messages); return null; }

    const event: MemoryEvent = {
      id: randomUUID(),
      chatId,
      sessionId: chatId,
      character: character.id,
      summary,
      emotion: extraction.emotion.trim().slice(0, 40) || "平静",
      importance,
      keyPoints,
      content: `${summary}\n${keyPoints.join("\n")}`.slice(0, 800),
      category: "interaction",
      timestamp: Date.now(),
      tags: [character.id, "interaction", extraction.eventType],
      sourceMessageId: latestAssistant.id,
      status: "pending", eventType: extraction.eventType, temporalState: extraction.temporalState,
      occurredAt: extraction.occurredAt, recordedAt: latestUser.timestamp,
      factKey: extraction.factKey?.trim().slice(0, 80),
    };

    this.repository.saveMemory(event);
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
   * @returns 提炼后的核心记忆对象，若 LLM 不可用或记忆不足则返回 null
   */
  async consolidateCoreMemory(
    chatId: string,
    character: CharacterProfile,
  ): Promise<CoreMemory | null> {
    if (!this.llmService) return null;

    if (this.repository.getCoreCandidate(chatId, character.id)) return null;
    const cursor = this.repository.getConsolidationSequence(chatId, character.id);
    const nextBatch = this.repository.listTimelineEvents(chatId, character.id, "confirmed")
      .filter((event) => (event.sequence ?? 0) > cursor).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).slice(0, CORE_MEMORY_CONSOLIDATION_INTERVAL);
    const recentEvents = [...nextBatch].sort((a, b) => (a.occurredAt ?? a.recordedAt ?? a.timestamp) - (b.occurredAt ?? b.recordedAt ?? b.timestamp) || (a.sequence ?? 0) - (b.sequence ?? 0));
    if (recentEvents.length < CORE_MEMORY_CONSOLIDATION_INTERVAL) return null;

    const currentCore = this.repository.getCoreMemory(chatId, character.id);
    const memoriesText = recentEvents.map((e) => (e.summary || e.content).slice(0, 240));

    try {
      const result = await this.llmService.consolidateCoreMemory({
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
        userPreferences: [...new Set(result.userPreferences)].slice(0, 12),
        userTraits: [...new Set(result.userTraits)].slice(0, 12),
        relationshipStage: result.relationshipStage || (currentCore?.relationshipStage ?? ""),
        relationshipNotes: [...new Set(result.relationshipNotes)].slice(0, 12),
        keyFacts: [...new Set(result.keyFacts)].slice(0, 16),
        lastUpdated: Date.now(),
      };

      const candidate: CoreMemoryCandidate = { id: randomUUID(), chatId, character: character.id, core, sourceSequence: Math.max(...recentEvents.map((event) => event.sequence ?? cursor)), createdAt: Date.now() };
      this.repository.saveCoreCandidate(candidate);
      return core;
    } catch {
      return currentCore ?? null;
    }
  }

  getSnapshot(chatId: string): ChatMemorySnapshot {
    return { events: this.repository.listTimelineEvents(chatId), coreMemories: this.repository.listCoreMemories(chatId), coreCandidates: this.repository.listCoreCandidates(chatId) };
  }

  async confirmEvent(chatId: string, eventId: string): Promise<MemoryEvent | undefined> {
    const previous = this.repository.getMemoryEvent(chatId, eventId);
    const event = this.repository.updateMemoryStatus(chatId, eventId, "confirmed");
    if (!event) return undefined;
    if (previous?.status === "confirmed") return event;
    this.repository.supersedeConflictingFacts(event);
    try { await this.elasticsearchService.indexMemory(event); } catch (error) { console.warn("[MemoryService] confirmed event ES index failed:", error); }
    const character = this.repository.getCharacter(event.character);
    if (character) await this.consolidateCoreMemory(chatId, character);
    return event;
  }

  dismissEvent(chatId: string, eventId: string): MemoryEvent | undefined {
    return this.repository.updateMemoryStatus(chatId, eventId, "dismissed");
  }

  deleteConfirmedEvent(chatId: string, eventId: string): boolean {
    const event = this.repository.listTimelineEvents(chatId).find((item) => item.id === eventId && item.status === "confirmed");
    if (!event) return false;
    this.repository.deleteMemoryEvent(eventId); void this.elasticsearchService.deleteMemory(eventId).catch(() => undefined); return true;
  }

  confirmCoreCandidate(chatId: string, characterId: string): CoreMemory | undefined {
    const candidate = this.repository.getCoreCandidate(chatId, characterId);
    if (!candidate || candidate.chatId !== chatId) return undefined;
    this.repository.saveCoreMemory(candidate.core); this.repository.setConsolidationSequence(chatId, characterId, candidate.sourceSequence); this.repository.deleteCoreCandidate(chatId, characterId);
    return candidate.core;
  }

  dismissCoreCandidate(chatId: string, characterId: string): boolean {
    const candidate = this.repository.getCoreCandidate(chatId, characterId); if (!candidate || candidate.chatId !== chatId) return false;
    this.repository.setConsolidationSequence(chatId, characterId, candidate.sourceSequence); this.repository.deleteCoreCandidate(chatId, characterId); return true;
  }
}
