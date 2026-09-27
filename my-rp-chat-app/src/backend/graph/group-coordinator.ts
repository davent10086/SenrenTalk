import { type LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import {
  createDefaultGroupChatRoomConfig,
  createDefaultGroupChatRoomState,
  normalizeGroupChatRoomConfig,
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
    generationReason: GroupChatGenerationReason,
    closingTurn = false,
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
    } else if (closingTurn || generationReason === "host_closing") {
      lines.push("你正在为本轮主持收尾。只有能简短总结新的共识或下一步时才发言，否则设置 skip=true；不要再点名其他角色。");
    } else if (this.roomConfig.mode === "host_mode") {
      if (this.roomConfig.hostRoleId === roleId) {
        lines.push(round === 1 && generationReason === "host_prompted"
          ? "你是主持角色，请先回应用户，再视情况通过 nextSpeaker 点名下一位角色。"
          : "你是主持角色，请回应上一位角色；需要时可通过 nextSpeaker 点名下一位角色。");
      } else {
        lines.push("这是主持模式，请回应上一位角色或用户的问题；需要时可通过 nextSpeaker 点名下一位角色。");
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
  ): { replyToMessageId?: string; replyToRoleId?: string } {
    const lastMessage = sharedHistory.at(-1);
    return {
      replyToMessageId: lastMessage?.id,
      replyToRoleId: lastMessage?.role === "assistant" ? lastMessage.roleId ?? undefined : undefined,
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
    if (targetRoleId) {
      return [targetRoleId];
    }
    if (this.roomConfig.mode === "host_mode") {
      const hostRoleId = this.roomConfig.hostRoleId!;
      const others = participants.filter((participant) => participant !== hostRoleId);
      return [hostRoleId, ...others];
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
    closingTurn?: boolean;
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
      closingTurn,
      generationReason,
    } = params;

    const groupContext = this.buildGroupContext(
      roleId,
      participants,
      sharedHistory,
      round,
      targetRoleId,
      generationReason,
      closingTurn,
      antiRepeatInstruction,
    );
    const replyTarget = this.resolveReplyTarget(sharedHistory);
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
    const roomConfig = normalizeGroupChatRoomConfig(participants.length, {
      ...createDefaultGroupChatRoomConfig(participants.length),
      ...this.roomConfig,
      maxMessages: this.roomConfig.maxMessages || Math.max(1, participants.length),
    });
    let roomState = createDefaultGroupChatRoomState(roomConfig);
    let sharedHistory = [...messages];
    let generatedCount = 0;
    let round = 1;
    let finishReason = "本轮已结束";
    const directedTarget = mentionTarget ?? roomConfig.targetRoleId ?? null;
    if (directedTarget && !participants.includes(directedTarget)) {
      throw new Error("定向回复的角色不属于当前房间。");
    }
    if (roomConfig.mode === "host_mode" &&
      (!roomConfig.hostRoleId || !participants.includes(roomConfig.hostRoleId))) {
      throw new Error("请先为主持模式选择房间内的主持角色。");
    }

    participants.forEach((participant) => this.getOrCreateAgent(participant));

    let deferredNomination: string | undefined;
    let hostClosed = false;
    let guestMessageCount = 0;
    while (generatedCount < roomConfig.maxMessages && round <= roomConfig.maxRounds) {
      this.ensureNotAborted();
      const targetRoleId = directedTarget;
      const fallbackOrder = this.planRound({ participants, targetRoleId, round, sharedHistory });
      const attempted = new Set<string>();
      const roundSpeakers: string[] = [];
      const roundSkipped: string[] = [];
      const roundFailed: string[] = [];
      const skippedRoles: Array<{ roleId: string; reason: GroupChatSkipReason }> = [];
      const roundStartedAt = Date.now();
      let immediateNomination = deferredNomination;
      deferredNomination = undefined;
      let turnIndex = 0;
      let closingAttempted = false;

      this.deps.sseService.publish({
        type: "round_started", streamId, round, mode: roomConfig.mode, targetRoleId,
      });
      roomState = {
        ...roomState, currentRound: round, currentTurn: 0,
        plannedSpeakers: fallbackOrder, lastTargetRoleId: targetRoleId,
      };
      this.publishRoomState(chatId, roomState);

      for (;;) {
        this.ensureNotAborted();
        if (closingAttempted) break;
        if (generatedCount >= roomConfig.maxMessages) {
          finishReason = "达到本房间消息上限";
          break;
        }
        const remaining = fallbackOrder.filter((participant) => !attempted.has(participant));
        const canClose = !targetRoleId && remaining.length === 0 && roomConfig.mode === "host_mode" &&
          !closingAttempted && (!deferredNomination || round >= roomConfig.maxRounds) && guestMessageCount > 0;
        if (remaining.length === 0 && !canClose) break;

        const isClosing = remaining.length === 0;
        const nominated = !isClosing && immediateNomination && remaining.includes(immediateNomination)
          ? immediateNomination : undefined;
        const speaker = isClosing ? roomConfig.hostRoleId! : nominated ?? remaining[0];
        immediateNomination = undefined;
        const candidates = isClosing ? [speaker] : [speaker, ...remaining.filter((roleId) => roleId !== speaker)];
        turnIndex += 1;
        this.deps.sseService.publish({
          type: "round_plan", streamId, round, plannedSpeakers: candidates,
          mode: roomConfig.mode, targetRoleId,
        });
        roomState = { ...roomState, currentTurn: turnIndex, plannedSpeakers: candidates };
        this.publishRoomState(chatId, roomState);

        if (this.breathingDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.breathingDelayMs));
        }
        const generationReason: GroupChatGenerationReason = isClosing ? "host_closing"
          : targetRoleId ? "mentioned"
          : nominated ? "nominated"
          : roomConfig.mode === "host_mode" && speaker === roomConfig.hostRoleId ? "host_prompted"
          : "scheduled";

        try {
          const previousSameRole = this.findPreviousAssistantMessage(sharedHistory, speaker);
          let result = await this.runAgentTurn({
            roleId: speaker, participants, sharedHistory, chatId, streamId, targetRoleId,
            round, turnIndex, tracer, generationReason,
            closingTurn: isClosing,
          });
          let latestMessage = result.messages.at(-1);
          if (!result.skip && latestMessage?.role === "assistant" && latestMessage.roleId === speaker &&
            isSimilarToPrevious(previousSameRole?.content, latestMessage.content)) {
            this.deps.repository.deleteMessage(latestMessage.id);
            result = await this.runAgentTurn({
              roleId: speaker, participants, sharedHistory, chatId, streamId, targetRoleId,
              round, turnIndex, tracer, generationReason: "retry_rewrite",
              closingTurn: isClosing,
              antiRepeatInstruction: "不要重复你刚刚说过的内容，请补充新信息或换一个角度回应。",
            });
            latestMessage = result.messages.at(-1);
          }
          if (!result.skip && latestMessage?.role === "assistant" && latestMessage.roleId === speaker &&
            isSimilarToPrevious(previousSameRole?.content, latestMessage.content)) {
            this.deps.repository.deleteMessage(latestMessage.id);
            result = { messages: sharedHistory, skip: true, skipReason: "similar_to_last" };
            this.publishRoleSkipped(streamId, speaker, round, "similar_to_last",
              `${speaker} 没有新的信息可补充，本轮保持沉默。`);
          }
          if (!result.skip && (!latestMessage || latestMessage.role !== "assistant" ||
            latestMessage.roleId !== speaker || latestMessage.id === sharedHistory.at(-1)?.id)) {
            result = { messages: sharedHistory, skip: true, skipReason: "no_new_value" };
          }

          if (result.skip) {
            const reason = result.skipReason ?? "no_new_value";
            roundSkipped.push(speaker);
            skippedRoles.push({ roleId: speaker, reason });
            if (reason !== "similar_to_last") {
              this.publishRoleSkipped(streamId, speaker, round, reason, `${speaker} 选择保持沉默。`);
            }
            if (isClosing) finishReason = "主持人没有新的收尾内容";
          } else {
            sharedHistory = result.messages;
            generatedCount += 1;
            roundSpeakers.push(speaker);
            if (roomConfig.mode === "host_mode" && speaker !== roomConfig.hostRoleId) guestMessageCount += 1;
            if (isClosing) {
              hostClosed = true;
              finishReason = "主持人已收尾";
            } else if (!targetRoleId && roomConfig.mode !== "single_round") {
              const nominee = result.nextSpeaker?.trim();
              if (nominee && nominee !== speaker && participants.includes(nominee)) {
                if (attempted.has(nominee)) deferredNomination = nominee;
                else immediateNomination = nominee;
              }
            }
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          const message = error instanceof Error ? error.message : "未知错误";
          roundFailed.push(speaker);
          this.deps.sseService.publish({
            type: "error", streamId, roleId: speaker,
            message: `角色 ${speaker} 发言失败：${message}`,
          });
        }
        if (isClosing) closingAttempted = true;
        else attempted.add(speaker);
        roomState = {
          ...roomState, currentTurn: turnIndex,
          plannedSpeakers: fallbackOrder.filter((participant) => !attempted.has(participant)),
          lastSpeakers: [...roundSpeakers], skippedRoles: [...skippedRoles],
        };
        this.publishRoomState(chatId, roomState);
      }

      this.deps.sseService.publish({
        type: "round_stats", streamId, round, generatedCount: roundSpeakers.length,
        speakers: roundSpeakers, skipped: roundSkipped, failed: roundFailed,
        durationMs: Math.max(0, Date.now() - roundStartedAt),
      });
      if (targetRoleId || roomConfig.mode === "single_round") {
        finishReason = targetRoleId ? "仅定向角色回复" : "本轮已结束";
        break;
      }
      if (hostClosed || closingAttempted || generatedCount >= roomConfig.maxMessages) break;
      if (!deferredNomination) {
        finishReason = roundSpeakers.length === 0 ? "其余角色没有新内容" : "对话自然结束";
        break;
      }
      if (round >= roomConfig.maxRounds) {
        finishReason = "达到本轮上限";
        break;
      }
      round += 1;
    }

    roomState = {
      ...roomState,
      lastFinishedReason: finishReason,
      currentRound: round,
      plannedSpeakers: [],
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
