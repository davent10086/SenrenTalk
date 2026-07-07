import { useMemo, useReducer, useRef } from "react";
import type { ChatMode, ChatSendResult } from "../../common/types";
import * as apiClient from "../api/client";
import type { PendingAttachmentDraft } from "../types";
import {
  initialChatStreamState,
  reduceChatStreamState,
} from "./chat-stream-state";

interface SendMessageInput {
  chatId: string;
  content: string;
  mode: ChatMode;
  participants: string[];
  mentionTarget?: string | null;
  targetRoleId?: string | null;
  attachments?: PendingAttachmentDraft[];
}

interface UseChatStreamOptions {
  onMessagesChanged: () => Promise<void>;
}

export function useChatStream(options: UseChatStreamOptions) {
  const [state, dispatch] = useReducer(reduceChatStreamState, initialChatStreamState);
  const isStreamingRef = useRef(false);
  const activeStreamRef = useRef<{ jobId: string; cancel: () => Promise<void> } | null>(null);

  const orderedDrafts = useMemo(() => state.drafts, [state.drafts]);

  function resetLocalStreamState(): void {
    isStreamingRef.current = false;
    dispatch({ type: "reset" });
  }

  function resetStream(): void {
    activeStreamRef.current = null;
    resetLocalStreamState();
  }

  function prepareStream(): void {
    isStreamingRef.current = true;
    dispatch({ type: "prepare" });
  }

  async function connectToStream(stream: ChatSendResult): Promise<void> {
    await new Promise<void>((resolve) => {
      const source = new EventSource(stream.streamUrl);
      let settled = false;
      const completedRoles = new Set<string>();

      const clearActiveStream = () => {
        if (activeStreamRef.current?.jobId === stream.jobId) {
          activeStreamRef.current = null;
        }
      };

      const finishStream = async () => {
        if (settled) {
          return;
        }
        settled = true;
        source.close();
        clearActiveStream();
        isStreamingRef.current = false;
        dispatch({ type: "finish" });
        await options.onMessagesChanged();
        resolve();
      };

      const handleError = async (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        source.close();
        clearActiveStream();
        isStreamingRef.current = false;
        dispatch({ type: "error", message });
        await options.onMessagesChanged();
        resolve();
      };

      const cancelStream = async () => {
        if (settled) {
          return;
        }
        settled = true;
        source.close();
        clearActiveStream();
        isStreamingRef.current = false;
        dispatch({ type: "notice", message: "已中断" });
        await apiClient.cancelJob(stream.jobId).catch(() => {});
        await options.onMessagesChanged();
        resolve();
      };

      activeStreamRef.current = {
        jobId: stream.jobId,
        cancel: cancelStream,
      };

      const safeParse = <T,>(raw: string): T | null => {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      };

      source.addEventListener("status", (event) => {
        const payload = safeParse<{ roleId?: string | null; message: string }>(
          (event as MessageEvent<string>).data,
        );
        if (!payload) {
          return;
        }

        const roleId = payload.roleId ?? "__default__";
        dispatch({
          type: "status",
          roleId,
          message: payload.message,
          activeRoleId: payload.roleId ?? null,
        });
      });

      source.addEventListener("token", (event) => {
        const payload = safeParse<{ roleId?: string | null; token: string }>(
          (event as MessageEvent<string>).data,
        );
        if (!payload) {
          return;
        }

        const roleId = payload.roleId ?? "__default__";
        if (completedRoles.has(roleId)) {
          return;
        }

        dispatch({
          type: "token",
          roleId,
          token: payload.token,
          activeRoleId: payload.roleId ?? null,
        });
      });

      source.addEventListener("message_done", async (event) => {
        const payload = safeParse<{ roleId?: string | null }>(
          (event as MessageEvent<string>).data,
        );
        if (!payload) {
          return;
        }

        const roleId = payload.roleId ?? "__default__";
        completedRoles.add(roleId);
        dispatch({ type: "complete", roleId });
        await options.onMessagesChanged();
      });

      source.addEventListener("audio_ready", async () => {
        await options.onMessagesChanged();
      });

      source.addEventListener("audio_failed", async () => {
        await options.onMessagesChanged();
      });

      source.addEventListener("round_started", (event) => {
        const payload = safeParse<{ round: number; mode: ChatMode | string; targetRoleId?: string | null }>(
          (event as MessageEvent<string>).data,
        );
        if (!payload) {
          return;
        }
        dispatch({
          type: "round_started",
          round: payload.round,
          roomMode: payload.mode as never,
          targetRoleId: payload.targetRoleId ?? null,
        });
      });

      source.addEventListener("round_plan", (event) => {
        const payload = safeParse<{
          round: number;
          mode: ChatMode | string;
          plannedSpeakers: string[];
          targetRoleId?: string | null;
        }>((event as MessageEvent<string>).data);
        if (!payload) {
          return;
        }
        dispatch({
          type: "round_plan",
          round: payload.round,
          plannedSpeakers: payload.plannedSpeakers ?? [],
          roomMode: payload.mode as never,
          targetRoleId: payload.targetRoleId ?? null,
        });
      });

      source.addEventListener("role_skipped", (event) => {
        const payload = safeParse<{
          roleId: string;
          reason: string;
          message: string;
        }>((event as MessageEvent<string>).data);
        if (!payload) {
          return;
        }
        dispatch({
          type: "role_skipped",
          roleId: payload.roleId,
          reason: payload.reason as never,
          message: payload.message,
        });
      });

      source.addEventListener("room_finished", (event) => {
        const payload = safeParse<{ reason: string }>((event as MessageEvent<string>).data);
        if (!payload) {
          return;
        }
        dispatch({ type: "room_finished", reason: payload.reason });
      });

      source.addEventListener("error", (event) => {
        const rawData = "data" in event ? (event as MessageEvent<string>).data : undefined;
        if (typeof rawData !== "string" || rawData.length === 0) {
          return;
        }

        const payload = safeParse<{ message?: string }>(rawData);
        void handleError(payload?.message ?? "流式对话失败");
      });

      source.onerror = () => {
        void finishStream();
      };
    });
  }

  async function runStreamRequest(requestFactory: () => Promise<ChatSendResult>): Promise<void> {
    if (isStreamingRef.current) {
      dispatch({ type: "error", message: "正在生成回复，请稍后再试" });
      return;
    }

    prepareStream();

    let stream: ChatSendResult;
    try {
      stream = await requestFactory();
    } catch (error) {
      isStreamingRef.current = false;
      dispatch({
        type: "error",
        message: error instanceof Error
          ? error.message
          : "发送消息失败，请检查网络连接或后端服务",
      });
      throw error;
    }

    await connectToStream(stream);
  }

  async function sendMessage(input: SendMessageInput): Promise<void> {
    await runStreamRequest(() =>
      apiClient.sendMessage({
        chatId: input.chatId,
        content: input.content,
        mode: input.mode,
        participants: input.participants,
        mentionTarget: input.mentionTarget,
        targetRoleId: input.targetRoleId,
        attachments: input.attachments,
      }),
    );
  }

  async function stopStream(): Promise<void> {
    await activeStreamRef.current?.cancel();
  }

  return {
    drafts: orderedDrafts,
    agentStatus: state.agentStatus,
    activeRoleId: state.activeRoleId,
    isStreaming: state.isStreaming,
    error: state.error,
    notice: state.notice,
    currentRound: state.currentRound,
    plannedSpeakers: state.plannedSpeakers,
    skippedRoles: state.skippedRoles,
    finishedReason: state.finishedReason,
    roomMode: state.roomMode,
    targetRoleId: state.targetRoleId,
    sendMessage,
    runStreamRequest,
    stopStream,
    resetStream,
  };
}
