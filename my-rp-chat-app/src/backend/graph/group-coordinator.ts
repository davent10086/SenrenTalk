import { type LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { createSingleChatGraph, type ChatGraphState, type GraphDependencies } from "./chat-graphs";
import type { ChatMessage, ChatMode } from "../../common/types";

/** 群聊模式下默认最大生成消息数，防止无限循环。 */
const DEFAULT_MAX_MESSAGES = 15;
/** 默认最大轮次数（每轮每个角色至少发言一次）。 */
const DEFAULT_MAX_ROUNDS = 3;
/** 连续多少轮无人发言则自动退出。 */
const DEFAULT_IDLE_STREAK_THRESHOLD = 2;

/**
 * 群聊协调器。
 *
 * 负责管理多角色群聊的全生命周期：
 * - @mention 定向发言：第一轮仅被 @ 的角色发言
 * - 动态排序：agent 可通过 nextSpeaker 指定下一位发言者
 * - 异步记忆处理：所有 agent 发言结束后批量提取/整合记忆
 *
 * 使用方式：AppRuntime.sendMessage 中单次调用 {@link runSession}。
 */
export class GroupChatCoordinator {
  private readonly deps: GraphDependencies;
  private readonly agents = new Map<string, ReturnType<typeof createSingleChatGraph>>();
  private readonly maxMessages: number;
  private readonly maxRounds: number;
  private readonly idleStreakThreshold: number;

  /**
   * @param deps                 图执行依赖
   * @param maxMessages          本轮会话最大生成消息数（默认 15）
   * @param maxRounds            最大轮次数，每轮至少一轮所有角色发言（默认 3）
   * @param idleStreakThreshold 连续多少轮无人发言则自动退出（默认 2）
   */
  constructor(
    deps: GraphDependencies,
    maxMessages = DEFAULT_MAX_MESSAGES,
    maxRounds = DEFAULT_MAX_ROUNDS,
    idleStreakThreshold = DEFAULT_IDLE_STREAK_THRESHOLD,
  ) {
    this.deps = deps;
    this.maxMessages = maxMessages;
    this.maxRounds = maxRounds;
    this.idleStreakThreshold = idleStreakThreshold;
  }

  /** 懒加载创建或获取指定角色的 agent 图实例。 */
  private getOrCreateAgent(roleId: string): ReturnType<typeof createSingleChatGraph> {
    let agent = this.agents.get(roleId);
    if (!agent) {
      agent = createSingleChatGraph(this.deps);
      this.agents.set(roleId, agent);
    }
    return agent;
  }

  /**
   * 构造群聊上下文提示词。
   *
   * 包含参与者列表、最近发言记录、@mention 指令、nextSpeaker 引导等。
   * 被 @ 但非目标的角色会收到"保持沉默"指令。
   */
  private formatGroupContext(
    roleId: string,
    participants: string[],
    sharedHistory: ChatMessage[],
    turnCount: number,
    mentionTarget?: string | null,
  ): string {
    const recentMessages = sharedHistory
      .slice(-8)
      .map((m) => `${m.roleId ?? (m.role === "user" ? "用户" : m.role)}：${m.content}`)
      .join("\n");

    const otherParticipants = participants.filter((p) => p !== roleId);

    const lines = [
      "=== 群聊模式 ===",
      `群聊参与者：${participants.join("、")}`,
      `你的名字是 ${roleId}。`,
      `这是第 ${turnCount + 1} 轮对话。`,
    ];

    if (mentionTarget) {
      lines.push(`用户 @了 ${mentionTarget}，这条消息是给 ${mentionTarget} 的。`);
      if (roleId !== mentionTarget) {
        lines.push("你没有被@，本轮你应该保持沉默，不要发言。等下一轮再回应。");
      } else {
        lines.push("用户@了你，请优先回应。");
      }
    }

    /** 动态排序指令的最大轮次，超过后不再提示可指定 nextSpeaker。 */
    const DYNAMIC_ORDERING_ROUNDS = 2;

    // Dynamic ordering instruction
    if (otherParticipants.length > 0 && !mentionTarget && turnCount < DYNAMIC_ORDERING_ROUNDS) {
      lines.push(
        `你可以自由选择回应对象。`,
        `如果你想对某个特定角色说话，请在 JSON 回复中添加 "nextSpeaker" 字段，`,
        `指定你希望接下来发言的角色名。可选值：${otherParticipants.join("、")}。`,
        `如果不需要指定，就不要加这个字段。`,
        `注意：群聊不宜过长，2~3 轮后应主动停止指定 nextSpeaker，让对话自然收尾。`,
      );
    } else if (!mentionTarget && turnCount >= DYNAMIC_ORDERING_ROUNDS) {
      // 超过动态排序轮次，提示自然结束
      lines.push(
        `群聊已进入尾声。请完成本轮对话后主动停止发言。`,
        `不要在 JSON 中添加 "nextSpeaker" 字段，让对话自然结束。`,
      );
    }

    lines.push("");
    if (recentMessages) {
      lines.push(`=== 最近的群聊消息 ===\n${recentMessages}`);
    }

    return lines.filter(Boolean).join("\n").trim();
  }

  /**
   * 执行单个 agent 的一次发言。
   *
   * 构造 groupContext + 初始状态，调用 agent.invoke 运行完整的
   * prepare → retrieve → build → LLM → validate → save 流程。
   *
   * @returns 更新后的消息列表和 agent 指定的 nextSpeaker
   */
  private async runAgentTurn(params: {
    roleId: string;
    participants: string[];
    sharedHistory: ChatMessage[];
    chatId: string;
    streamId: string;
    mentionTarget: string | null;
    turnCount: number;
    tracer?: LangChainTracer;
  }): Promise<{ messages: ChatMessage[]; nextSpeaker?: string }> {
    const { roleId, participants, sharedHistory, chatId, streamId, mentionTarget, turnCount, tracer } = params;

    const groupContext = this.formatGroupContext(
      roleId,
      participants,
      sharedHistory,
      turnCount,
      mentionTarget,
    );

    const agent = this.getOrCreateAgent(roleId);
    const state = {
      chatId,
      streamId,
      mode: "group" as ChatMode,
      participants,
      mentionTarget,
      activeRoleIndex: 0,
      currentRoleId: roleId,
      messages: sharedHistory,
      retrievedDocs: [] as ChatGraphState["retrievedDocs"],
      memories: [] as ChatGraphState["memories"],
      summary: this.deps.memoryService.getSummary(chatId),
      prompt: "",
      output: "",
      speechTextJa: "",
      retryCount: 0,
      validationIssue: undefined as string | undefined,
      character: undefined,
      coreMemory: undefined as string | undefined,
      groupContext,
    };

    const config: Record<string, unknown> = { recursionLimit: 100 };
    if (tracer) {
      config.callbacks = [tracer];
    }

    const result = await agent.invoke(state, config);
    return {
      messages: result.messages,
      nextSpeaker: result.nextSpeaker as string | undefined,
    };
  }

  /**
   * 异步批量处理记忆：为每个 participant 提取情景记忆（L2）并整合核心记忆（L3）。
   * 在 runSession 末尾 fire-and-forget 调用，不阻塞对话流。
   */
  private async processMemories(
    chatId: string,
    participants: string[],
    finalHistory: ChatMessage[],
  ): Promise<void> {
    // 并行处理所有角色的记忆提取与整合，错误隔离到单个角色
    await Promise.all(
      participants.map(async (roleId) => {
        try {
          const character = this.deps.repository.getCharacter(roleId);
          if (!character) return;

          // Extract episodic memory (L2)
          await this.deps.memoryService.extractAndPersist(chatId, character, finalHistory);

          // Consolidate core memory (L3)
          await this.deps.memoryService.consolidateCoreMemory(chatId, character, finalHistory);
        } catch (error) {
          console.warn(`[GroupChatCoordinator] Memory processing failed for ${roleId}:`, error);
        }
      }),
    );
  }

  /**
   * 运行群聊会话主流程。
   *
   * 1. Turn 0：@mention 定向发言（仅被 @ 的角色回复）
   * 2. 后续轮次：agent 通过 nextSpeaker 动态决定发言顺序，
   *    未指定时回退到参与者列表的轮询顺序
   * 3. 所有 agent 发言完毕后，fire-and-forget 异步处理记忆
   */
  async runSession(params: {
    chatId: string;
    streamId: string;
    participants: string[];
    mentionTarget: string | null;
    messages: ChatMessage[];
    tracer?: LangChainTracer;
  }): Promise<void> {
    const { chatId, streamId, participants, mentionTarget, messages, tracer } = params;

    // 注册所有参与者 agent（懒初始化）
    participants.forEach((p) => this.getOrCreateAgent(p));

    let sharedHistory = [...messages];
    let generatedCount = 0;
    let turnCount = 0;

    // 跟踪本轮尚未发言的角色，全部发言后自动重置
    const unspoken = new Set<string>(participants);

    /** 按原始参与顺序返回第一个未发言者。 */
    function firstUnspoken(): string | undefined {
      for (const p of participants) {
        if (unspoken.has(p)) return p;
      }
      return undefined;
    }

    /** 根据 agent 指定的 nextSpeaker 确定实际下一个发言者。 */
    function resolveNextSpeaker(preferred: string | undefined, currentUnspoken: Set<string>): string | undefined {
      if (!preferred) return firstUnspoken();
      // 优先使用 agent 指定的发言者（必须为有效参与者且本轮未发言）
      if (participants.includes(preferred)) {
        if (currentUnspoken.has(preferred)) return preferred;
        // 已发言 → 回退到轮询顺序
      }
      return firstUnspoken();
    }

    // ── Turn 0: @mention handling ──
    // 注意：Turn 0 只是第 1 轮的一部分，不单独递增 turnCount。
    // turnCount 仅在一轮所有角色发言完毕后递增。
    const hasMention = mentionTarget != null;
    if (hasMention) {
      const speaker = mentionTarget!;
      try {
        const result = await this.runAgentTurn({
          roleId: speaker,
          participants,
          sharedHistory,
          chatId,
          streamId,
          mentionTarget: speaker,
          turnCount,
          tracer,
        });
        sharedHistory = result.messages;
        generatedCount++;
        unspoken.delete(speaker);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "未知错误";
        console.error(`[GroupChatCoordinator] Agent ${speaker} failed:`, msg);
        this.deps.sseService.publish({
          type: "error", streamId, roleId: speaker,
          message: `角色 ${speaker} 发言失败：${msg}`,
        });
      }
    }

    // ── Subsequent turns: agents determine order via nextSpeaker ──
    let nextSpeaker: string | undefined = undefined;
    // 连续多少轮完成时没有任何 agent 指定 nextSpeaker
    let idleStreak = 0;
    // 跟踪本轮是否有任何 agent 指定了 nextSpeaker
    let roundHasNextSpeaker = false;

    while (generatedCount < this.maxMessages) {
      // 一轮结束：所有参与者都发言完毕
      if (unspoken.size === 0) {
        // 检查 idleStreak：本轮没有任何 agent 指定 nextSpeaker 则递增
        if (!roundHasNextSpeaker) {
          idleStreak++;
        } else {
          idleStreak = 0;
        }
        turnCount++;

        if (idleStreak >= this.idleStreakThreshold) {
          console.info(`[GroupChatCoordinator] 连续 ${idleStreak} 轮无人主动发言，退出`);
          break;
        }
        if (turnCount >= this.maxRounds) {
          console.info("[GroupChatCoordinator] 达到最大轮数，退出");
          break;
        }

        // 重置一轮状态，开始新的一轮
        participants.forEach((p) => unspoken.add(p));
        roundHasNextSpeaker = false;
        nextSpeaker = undefined;
      }

      const speaker = resolveNextSpeaker(nextSpeaker, unspoken);
      if (!speaker) break;

      try {
        const result = await this.runAgentTurn({
          roleId: speaker,
          participants,
          sharedHistory,
          chatId,
          streamId,
          mentionTarget: null,
          turnCount,
          tracer,
        });
        sharedHistory = result.messages;
        generatedCount++;
        unspoken.delete(speaker);

        // Agent 指定的下一位发言者
        nextSpeaker = result.nextSpeaker;
        if (nextSpeaker) {
          roundHasNextSpeaker = true;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "未知错误";
        console.error(`[GroupChatCoordinator] Agent ${speaker} failed:`, msg);
        this.deps.sseService.publish({
          type: "error", streamId, roleId: speaker,
          message: `角色 ${speaker} 发言失败：${msg}`,
        });
        unspoken.delete(speaker);
        nextSpeaker = undefined;
      }
    }

    // ── Post-session: async memory extraction ──
    // Fire and forget — don't block the session completion
    this.processMemories(chatId, participants, sharedHistory).catch((error) => {
      console.error("[GroupChatCoordinator] Memory processing failed:", error);
    });
  }
}