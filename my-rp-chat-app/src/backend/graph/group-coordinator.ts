import { type LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import {
  createDefaultGroupChatRoomConfig,
  createDefaultGroupChatRoomState,
  type ChatMessage,
  type ChatMode,
  type GroupChatGenerationReason,
  type GroupChatRoomConfig,
  type GroupChatSkipReason,
} from "../../common/types";
import { createSingleChatGraph } from "./chat-graphs";
import type { ChatGraphState, GraphDependencies } from "./graph-types";

const DEFAULT_IDLE_STREAK_THRESHOLD = 2;
const TURN_BREATHING_DELAY_MS = 200;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!?;:'"`~\-_=+()[\]{}<>/\\|@#$%^&*，。！？；：、（）【】《》“”‘’]/g, "");
}

function isSimilarToPrevious(previous: string | undefined, current: string): boolean {
  if (!previous) {
    return false;
  }
  const left = normalizeText(previous);
  const right = normalizeText(current);
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (left.length <= 30 || right.length <= 30) {
    return left.includes(right) || right.includes(left);
  }
  return false;
}

export class GroupChatCoordinator {
  private readonly deps: GraphDependencies;
  private readonly agents = new Map<string, ReturnType<typeof createSingleChatGraph>>();
  private readonly roomConfig: GroupChatRoomConfig;
  private readonly idleStreakThreshold: number;
  private readonly breathingDelayMs: number;
  private readonly legacyCompatibility: boolean;

  constructor(
    deps: GraphDependencies,
    roomConfigOrMaxMessages?: Partial<GroupChatRoomConfig> | number,
    maxRoundsOrIdleStreakThreshold = DEFAULT_IDLE_STREAK_THRESHOLD,
    idleStreakThresholdOrBreathingDelay = TURN_BREATHING_DELAY_MS,
    breathingDelayMs = TURN_BREATHING_DELAY_MS,
  ) {
    this.deps = deps;
    if (typeof roomConfigOrMaxMessages === "number" || roomConfigOrMaxMessages === undefined) {
      this.legacyCompatibility = true;
      this.roomConfig = {
        ...createDefaultGroupChatRoomConfig(2),
        mode: maxRoundsOrIdleStreakThreshold <= 1 ? "single_round" : "free_chat",
        maxMessages: typeof roomConfigOrMaxMessages === "number" ? roomConfigOrMaxMessages : 15,
        maxRounds: maxRoundsOrIdleStreakThreshold,
      };
      this.idleStreakThreshold = idleStreakThresholdOrBreathingDelay;
      this.breathingDelayMs = breathingDelayMs;
      return;
    }
    this.legacyCompatibility = false;
    this.roomConfig = {
      ...createDefaultGroupChatRoomConfig(2),
      ...roomConfigOrMaxMessages,
    };
    this.idleStreakThreshold = maxRoundsOrIdleStreakThreshold;
    this.breathingDelayMs = idleStreakThresholdOrBreathingDelay;
  }

  private getOrCreateAgent(roleId: string): ReturnType<typeof createSingleChatGraph> {
    let agent = this.agents.get(roleId);
    if (!agent) {
      agent = createSingleChatGraph(this.deps);
      this.agents.set(roleId, agent);
    }
    return agent;
  }

  private ensureNotAborted(): void {
    if (!this.deps.abortSignal?.aborted) {
      return;
    }
    const error = new Error("消息生成已中断");
    error.name = "AbortError";
    throw error;
  }

  private buildGroupContext(
    roleId: string,
    participants: string[],
    sharedHistory: ChatMessage[],
    round: number,
    targetRoleId: string | null,
    antiRepeatInstruction?: string,
  ): string {
    const recentMessages = sharedHistory
      .slice(-8)
      .map((message) => `${message.roleId ?? (message.role === "user" ? "用户" : message.role)}：${message.content}`)
      .join("\n");

    const lines = [
      "=== 群聊房间 ===",
      `房间模式：${this.roomConfig.mode}`,
      `参与角色：${participants.join("、")}`,
      `当前角色：${roleId}`,
      `当前轮次：第 ${round} 轮`,
      this.roomConfig.topic ? `房间主题：${this.roomConfig.topic}` : "",
      this.roomConfig.scene ? `当前场景：${this.roomConfig.scene}` : "",
      targetRoleId ? `当前定向目标：${targetRoleId}` : "",
      "请用 1-3 句完成本轮回应，聚焦当前角色视角，避免重复上轮原话。",
      antiRepeatInstruction ?? "",
      recentMessages ? `=== 最近消息 ===\n${recentMessages}` : "",
    ];

    if (this.roomConfig.mode === "single_round") {
      lines.push("本房间为单轮模式，本轮结束后不要继续主动拉起下一轮对话。");
    } else if (this.roomConfig.mode === "host_mode") {
      if (this.roomConfig.hostRoleId === roleId) {
        lines.push("你是主持角色，需要先回应用户，再视情况点名下一位角色。");
      } else {
        lines.push("这是主持模式，请优先回应主持角色或用户刚刚点名的内容。");
      }
    } else {
      lines.push("你可以在需要时通过 nextSpeaker 指定下一位角色，但不要无意义续聊。");
    }

    return lines.filter(Boolean).join("\n");
  }

  private publishRoomState(
    chatId: string,
    updates: Parameters<GraphDependencies["repository"]["updateChatRoomState"]>[1],
  ): void {
    this.deps.repository.updateChatRoomState(chatId, updates);
  }

  private resolveReplyTarget(
    sharedHistory: ChatMessage[],
    targetRoleId: string | null,
  ): { replyToMessageId?: string; replyToRoleId?: string } {
    const lastMessage = sharedHistory.at(-1);
    const lastUserMessage = [...sharedHistory].reverse().find((message) => message.role === "user");
    return {
      replyToMessageId: lastUserMessage?.id,
      replyToRoleId: targetRoleId ?? lastMessage?.roleId ?? undefined,
    };
  }

  private findPreviousAssistantMessage(sharedHistory: ChatMessage[], roleId: string): ChatMessage | undefined {
    for (let index = sharedHistory.length - 1; index >= 0; index -= 1) {
      const message = sharedHistory[index];
      if (message.role === "assistant" && message.roleId === roleId) {
        return message;
      }
    }
    return undefined;
  }

  private planRound(params: {
    participants: string[];
    targetRoleId: string | null;
    round: number;
    sharedHistory: ChatMessage[];
  }): string[] {
    const { participants, targetRoleId, round } = params;
    if (this.roomConfig.mode === "host_mode") {
      const hostRoleId = this.roomConfig.hostRoleId && participants.includes(this.roomConfig.hostRoleId)
        ? this.roomConfig.hostRoleId
        : participants[0];
      const others = participants.filter((participant) => participant !== hostRoleId);
      return [hostRoleId, ...others];
    }

    if (targetRoleId) {
      const rest = participants.filter((participant) => participant !== targetRoleId);
      if (this.roomConfig.mode === "single_round") {
        return [targetRoleId, ...rest];
      }
      return [targetRoleId, ...rest];
    }

    if (this.roomConfig.mode === "single_round") {
      return [...participants];
    }

    if (this.roomConfig.speakerPolicy === "round_robin") {
      const offset = (round - 1) % participants.length;
      return [...participants.slice(offset), ...participants.slice(0, offset)];
    }

    return [...participants];
  }

  private async runAgentTurn(params: {
    roleId: string;
    participants: string[];
    sharedHistory: ChatMessage[];
    chatId: string;
    streamId: string;
    targetRoleId: string | null;
    round: number;
    turnIndex: number;
    tracer?: LangChainTracer;
    antiRepeatInstruction?: string;
    generationReason: GroupChatGenerationReason;
  }): Promise<{
    messages: ChatMessage[];
    nextSpeaker?: string;
    skip?: boolean;
    skipReason?: GroupChatSkipReason;
  }> {
    const {
      roleId,
      participants,
      sharedHistory,
      chatId,
      streamId,
      targetRoleId,
      round,
      turnIndex,
      tracer,
      antiRepeatInstruction,
      generationReason,
    } = params;

    const groupContext = this.buildGroupContext(
      roleId,
      participants,
      sharedHistory,
      round,
      targetRoleId,
      antiRepeatInstruction,
    );
    const replyTarget = this.resolveReplyTarget(sharedHistory, targetRoleId);
    const state = {
      chatId,
      streamId,
      mode: "group" as ChatMode,
      participants,
      mentionTarget: targetRoleId,
      activeRoleIndex: 0,
      currentRoleId: roleId,
      messages: sharedHistory,
      retrievedDocs: [] as ChatGraphState["retrievedDocs"],
      memories: [] as ChatGraphState["memories"],
      summary: this.deps.memoryService.getSummary(chatId, roleId),
      prompt: "",
      output: "",
      speechTextJa: "",
      retryCount: 0,
      validationIssue: undefined as string | undefined,
      character: undefined,
      coreMemory: undefined as string | undefined,
      groupContext,
      skip: false,
      roomConfig: this.roomConfig,
      currentRound: round,
      turnIndex,
      replyToMessageId: replyTarget.replyToMessageId,
      replyToRoleId: replyTarget.replyToRoleId,
      generationReason,
      skipReason: undefined,
      antiRepeatInstruction,
    };

    const config: Record<string, unknown> = { recursionLimit: 100 };
    if (tracer) {
      config.callbacks = [tracer];
    }

    const result = await this.getOrCreateAgent(roleId).invoke(state, config);
    return {
      messages: result.messages,
      nextSpeaker: result.nextSpeaker as string | undefined,
      skip: result.skip as boolean | undefined,
      skipReason: result.skipReason as GroupChatSkipReason | undefined,
    };
  }

  private publishRoleSkipped(
    streamId: string,
    roleId: string,
    round: number,
    reason: GroupChatSkipReason,
    message: string,
  ): void {
    this.deps.sseService.publish({
      type: "role_skipped",
      streamId,
      roleId,
      round,
      reason,
      message,
    });
  }

  private publishRoomFinished(
    streamId: string,
    round: number,
    generatedCount: number,
    reason: string,
  ): void {
    this.deps.sseService.publish({
      type: "room_finished",
      streamId,
      round,
      generatedCount,
      reason,
    });
  }

  private async processMemories(
    chatId: string,
    participants: string[],
    finalHistory: ChatMessage[],
  ): Promise<void> {
    await Promise.all(
      participants.map(async (roleId) => {
        try {
          const character = this.deps.repository.getCharacter(roleId);
          if (!character) {
            return;
          }
          await this.deps.memoryService.extractAndPersist(chatId, character, finalHistory);
          await this.deps.memoryService.consolidateCoreMemory(chatId, character);
        } catch (error) {
          console.warn(`[GroupChatCoordinator] Memory processing failed for ${roleId}:`, error);
        }
      }),
    );
  }

  private async runLegacySession(params: {
    chatId: string;
    streamId: string;
    participants: string[];
    mentionTarget: string | null;
    messages: ChatMessage[];
    tracer?: LangChainTracer;
  }): Promise<void> {
    const { chatId, streamId, participants, mentionTarget, messages, tracer } = params;
    const effectiveMaxMessages = Math.min(this.roomConfig.maxMessages, participants.length * 2);
    let sharedHistory = [...messages];
    let generatedCount = 0;
    let round = 1;
    let nextSpeaker: string | undefined;
    let idleStreak = 0;
    const unspoken = new Set<string>(participants);
    let roundSpeakers: string[] = [];
    let roundFailed: string[] = [];

    const firstUnspoken = () => participants.find((participant) => unspoken.has(participant));
    const resolveNextSpeaker = (preferred?: string) => {
      if (preferred && participants.includes(preferred) && unspoken.has(preferred)) {
        return preferred;
      }
      return firstUnspoken();
    };

    if (mentionTarget) {
      const mentionResult = await this.runAgentTurn({
        roleId: mentionTarget,
        participants,
        sharedHistory,
        chatId,
        streamId,
        targetRoleId: mentionTarget,
        round,
        turnIndex: 1,
        tracer,
        generationReason: "mentioned",
      });
      sharedHistory = mentionResult.messages;
      generatedCount += mentionResult.skip ? 0 : 1;
      unspoken.delete(mentionTarget);
      nextSpeaker = mentionResult.nextSpeaker;
    }

    while (generatedCount < effectiveMaxMessages) {
      if (unspoken.size === 0) {
        if (!nextSpeaker) {
          idleStreak += 1;
        } else {
          idleStreak = 0;
        }
        this.deps.sseService.publish({
          type: "round_stats",
          streamId,
          round,
          generatedCount: roundSpeakers.length,
          speakers: [...roundSpeakers],
          skipped: [],
          failed: [...roundFailed],
          durationMs: 0,
        });
        roundSpeakers = [];
        roundFailed = [];
        if (idleStreak >= this.idleStreakThreshold) {
          break;
        }
        round += 1;
        if (round > this.roomConfig.maxRounds) {
          break;
        }
        participants.forEach((participant) => unspoken.add(participant));
        nextSpeaker = undefined;
      }

      const speaker = resolveNextSpeaker(nextSpeaker);
      if (!speaker) {
        break;
      }

      try {
        const result = await this.runAgentTurn({
          roleId: speaker,
          participants,
          sharedHistory,
          chatId,
          streamId,
          targetRoleId: null,
          round,
          turnIndex: participants.length - unspoken.size + 1,
          tracer,
          generationReason: nextSpeaker ? "nominated" : "scheduled",
        });
        sharedHistory = result.messages;
        if (!result.skip) {
          generatedCount += 1;
          roundSpeakers.push(speaker);
        }
        nextSpeaker = result.nextSpeaker;
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        roundFailed.push(speaker);
        this.deps.sseService.publish({
          type: "error",
          streamId,
          roleId: speaker,
          message: `角色 ${speaker} 发言失败：${message}`,
        });
        nextSpeaker = undefined;
      }
      unspoken.delete(speaker);
    }

    if (unspoken.size === 0 && (roundSpeakers.length > 0 || roundFailed.length > 0)) {
      this.deps.sseService.publish({
        type: "round_stats",
        streamId,
        round,
        generatedCount: roundSpeakers.length,
        speakers: [...roundSpeakers],
        skipped: [],
        failed: [...roundFailed],
        durationMs: 0,
      });
    }

    const memoryJob = this.processMemories(chatId, participants, sharedHistory);
    this.deps.trackAsyncJob?.(memoryJob);
    memoryJob.catch((error) => {
      console.error("[GroupChatCoordinator] Memory processing failed:", error);
    });
  }

  async runSession(params: {
    chatId: string;
    streamId: string;
    participants: string[];
    mentionTarget: string | null;
    messages: ChatMessage[];
    tracer?: LangChainTracer;
  }): Promise<void> {
    this.ensureNotAborted();
    if (this.legacyCompatibility) {
      await this.runLegacySession(params);
      return;
    }
    const { chatId, streamId, participants, mentionTarget, messages, tracer } = params;
    const roomConfig = {
      ...createDefaultGroupChatRoomConfig(participants.length),
      ...this.roomConfig,
      maxMessages: this.roomConfig.maxMessages || Math.max(1, participants.length),
    };
    let roomState = createDefaultGroupChatRoomState(roomConfig);
    let sharedHistory = [...messages];
    let generatedCount = 0;
    let round = 1;
    let idleStreak = 0;
    let finishReason = "本轮已结束";

    participants.forEach((participant) => this.getOrCreateAgent(participant));

    while (generatedCount < roomConfig.maxMessages && round <= roomConfig.maxRounds) {
      this.ensureNotAborted();
      const targetRoleId = mentionTarget ?? roomConfig.targetRoleId ?? null;
      const plannedSpeakers = this.planRound({
        participants,
        targetRoleId,
        round,
        sharedHistory,
      });
      const roundSpeakers: string[] = [];
      const roundSkipped: string[] = [];
      const roundFailed: string[] = [];
      const skippedRoles: Array<{ roleId: string; reason: GroupChatSkipReason }> = [];
      const roundStartedAt = Date.now();
      let nominatedNextSpeaker: string | undefined;

      this.deps.sseService.publish({
        type: "round_started",
        streamId,
        round,
        mode: roomConfig.mode,
        targetRoleId,
      });
      this.deps.sseService.publish({
        type: "round_plan",
        streamId,
        round,
        plannedSpeakers,
        mode: roomConfig.mode,
        targetRoleId,
      });
      roomState = {
        ...roomState,
        currentRound: round,
        currentTurn: 0,
        plannedSpeakers,
        lastTargetRoleId: targetRoleId,
      };
      this.publishRoomState(chatId, roomState);

      for (let index = 0; index < plannedSpeakers.length; index += 1) {
        this.ensureNotAborted();
        if (generatedCount >= roomConfig.maxMessages) {
          finishReason = "达到本房间消息上限";
          break;
        }
        const speaker = plannedSpeakers[index];
        if (this.breathingDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.breathingDelayMs));
        }

        const generationReason: GroupChatGenerationReason =
          targetRoleId && speaker === targetRoleId
            ? "mentioned"
            : roomConfig.mode === "host_mode" && speaker === roomConfig.hostRoleId
              ? "host_prompted"
              : nominatedNextSpeaker && speaker === nominatedNextSpeaker
                ? "nominated"
                : "scheduled";

        try {
          const previousSameRole = this.findPreviousAssistantMessage(sharedHistory, speaker);
          let result = await this.runAgentTurn({
            roleId: speaker,
            participants,
            sharedHistory,
            chatId,
            streamId,
            targetRoleId,
            round,
            turnIndex: index + 1,
            tracer,
            generationReason,
          });

          let updatedHistory = result.messages;
          let latestMessage = updatedHistory.at(-1);

          if (!result.skip && latestMessage?.role === "assistant" && latestMessage.roleId === speaker) {
            if (isSimilarToPrevious(previousSameRole?.content, latestMessage.content)) {
              this.deps.repository.deleteMessage(latestMessage.id);
              updatedHistory = sharedHistory;
              result = await this.runAgentTurn({
                roleId: speaker,
                participants,
                sharedHistory,
                chatId,
                streamId,
                targetRoleId,
                round,
                turnIndex: index + 1,
                tracer,
                generationReason: "retry_rewrite",
                antiRepeatInstruction: "不要重复你刚刚说过的内容，请补充新信息或换一个角度回应。",
              });
              updatedHistory = result.messages;
              latestMessage = updatedHistory.at(-1);
            }
          }

          if (!result.skip && latestMessage?.role === "assistant" && latestMessage.roleId === speaker) {
            if (isSimilarToPrevious(previousSameRole?.content, latestMessage.content)) {
              this.deps.repository.deleteMessage(latestMessage.id);
              result = {
                messages: sharedHistory,
                skip: true,
                skipReason: "similar_to_last",
                nextSpeaker: undefined,
              };
              this.publishRoleSkipped(
                streamId,
                speaker,
                round,
                "similar_to_last",
                `${speaker} 没有新的信息可补充，本轮保持沉默。`,
              );
            }
          }

          if (result.skip) {
            const reason = result.skipReason ?? "no_new_value";
            roundSkipped.push(speaker);
            skippedRoles.push({ roleId: speaker, reason });
            if (reason !== "similar_to_last") {
              this.publishRoleSkipped(
                streamId,
                speaker,
                round,
                reason,
                `${speaker} 选择保持沉默。`,
              );
            }
          } else {
            sharedHistory = result.messages;
            generatedCount += 1;
            roundSpeakers.push(speaker);
          }

          if (roomConfig.mode === "free_chat" && result.nextSpeaker && participants.includes(result.nextSpeaker)) {
            nominatedNextSpeaker = result.nextSpeaker;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "未知错误";
          roundFailed.push(speaker);
          this.deps.sseService.publish({
            type: "error",
            streamId,
            roleId: speaker,
            message: `角色 ${speaker} 发言失败：${message}`,
          });
        }
      }

      this.deps.sseService.publish({
        type: "round_stats",
        streamId,
        round,
        generatedCount: roundSpeakers.length,
        speakers: roundSpeakers,
        skipped: roundSkipped,
        failed: roundFailed,
        durationMs: Math.max(0, Date.now() - roundStartedAt),
      });

      roomState = {
        ...roomState,
        currentTurn: plannedSpeakers.length,
        lastSpeakers: roundSpeakers,
        skippedRoles,
        lastFinishedReason: finishReason,
      };
      this.publishRoomState(chatId, roomState);

      if (roomConfig.mode === "single_round") {
        finishReason = targetRoleId ? "仅定向角色回复" : "本轮已结束";
        break;
      }
      if (roundSpeakers.length === 0) {
        idleStreak += 1;
        if (idleStreak >= this.idleStreakThreshold) {
          finishReason = "其余角色没有新内容";
          break;
        }
      } else {
        idleStreak = 0;
      }
      if (generatedCount >= roomConfig.maxMessages) {
        finishReason = "达到本房间消息上限";
        break;
      }
      if (round >= roomConfig.maxRounds) {
        finishReason = roomConfig.mode === "host_mode" ? "主持人已收尾" : "达到本轮上限";
        break;
      }
      round += 1;
    }

    roomState = {
      ...roomState,
      lastFinishedReason: finishReason,
      currentRound: round,
      lastTargetRoleId: mentionTarget ?? roomConfig.targetRoleId ?? null,
    };
    this.publishRoomState(chatId, roomState);
    this.publishRoomFinished(streamId, round, generatedCount, finishReason);

    const memoryJob = this.processMemories(chatId, participants, sharedHistory);
    this.deps.trackAsyncJob?.(memoryJob);
    memoryJob.catch((error) => {
      console.error("[GroupChatCoordinator] Memory processing failed:", error);
    });
  }
}
