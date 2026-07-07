import { useEffect, useMemo, useState } from "react";
import { Square, Trash2, XCircle } from "lucide-react";
import type {
  ChatMessage,
  ChatRecord,
  GroupChatRoomConfig,
  GroupChatRoomMode,
  GroupChatRoomState,
  GroupChatSkipReason,
} from "../../common/types";
import * as apiClient from "../api/client";
import type { PendingAttachmentDraft } from "../types";
import { MessageComposer } from "./MessageComposer";
import { MessageList } from "./MessageList";

interface ChatWorkspaceProps {
  title: string;
  chat: ChatRecord | null;
  messages: ChatMessage[];
  drafts: Record<string, string>;
  agentStatus: Record<string, string>;
  activeRoleId: string | null;
  isStreaming: boolean;
  error: string | null;
  notice?: string | null;
  mentionTarget?: string | null;
  currentRound?: number;
  plannedSpeakers?: string[];
  skippedRoles?: Array<{ roleId: string; reason: GroupChatSkipReason; message: string }>;
  finishedReason?: string | null;
  roomMode?: GroupChatRoomMode | null;
  headerExtra?: React.ReactNode;
  onSend: (content: string, mentionTarget?: string | null, attachments?: PendingAttachmentDraft[]) => Promise<void>;
  onUpdateRoom?: (
    updates: { roomConfig?: Partial<GroupChatRoomConfig>; roomState?: Partial<GroupChatRoomState> },
  ) => Promise<void>;
  onRefreshMessages?: () => Promise<void>;
  onRetryAudio?: (messageId: string) => Promise<void>;
  onEditAndRegenerate?: (messageId: string, content: string) => Promise<void>;
  onStopGeneration?: () => Promise<void>;
  onClear?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const [retryingAudioIds, setRetryingAudioIds] = useState<Record<string, boolean>>({});
  const [attachmentDrafts, setAttachmentDrafts] = useState<PendingAttachmentDraft[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  const mediaPaths = useMemo(() => {
    const paths = new Set<string>();
    props.messages.forEach((message) => {
      message.metadata?.attachments?.forEach((attachment) => {
        if (attachment.relativePath) {
          paths.add(attachment.relativePath);
        }
      });
      if (message.metadata?.audio?.relativePath) {
        paths.add(message.metadata.audio.relativePath);
      }
    });
    return [...paths];
  }, [props.messages]);

  useEffect(() => {
    const missing = mediaPaths.filter((relativePath) => !mediaUrls[relativePath]);
    if (missing.length === 0) {
      return;
    }
    setMediaUrls((current) => ({
      ...current,
      ...Object.fromEntries(
        missing.map((relativePath) => [relativePath, apiClient.resolveMediaUrl(relativePath)]),
      ),
    }));
  }, [mediaPaths, mediaUrls]);

  const retryAudio = async (messageId: string) => {
    if (!props.onRetryAudio || retryingAudioIds[messageId]) {
      return;
    }
    setRetryingAudioIds((prev) => ({ ...prev, [messageId]: true }));
    try {
      await props.onRetryAudio(messageId);
    } finally {
      setRetryingAudioIds((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    }
  };

  const handleSend = async (content: string) => {
    await props.onSend(content, props.mentionTarget, attachmentDrafts);
    setAttachmentDrafts([]);
  };

  const effectiveRoomMode = props.roomMode ?? props.chat?.roomConfig?.mode ?? null;
  const effectiveRound = props.currentRound ?? props.chat?.roomState?.currentRound ?? 0;

  return (
    <section className="page chat-page">
      <div className="chat-header">
        <div>
          <h2>{props.title}</h2>
          <p>{props.chat ? props.chat.title : "请先创建或选择会话"}</p>
          {props.chat?.mode === "group" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "8px", fontSize: "0.85rem" }}>
              <span className="badge playable">{effectiveRoomMode ?? "single_round"}</span>
              <span className="muted">第 {effectiveRound} 轮</span>
              {props.mentionTarget ? <span className="muted">定向目标：@{props.mentionTarget}</span> : null}
              {props.plannedSpeakers?.length ? (
                <span className="muted">计划发言：{props.plannedSpeakers.join(" / ")}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {props.headerExtra}
          {props.activeRoleId ? (
            <span className="badge playable">
              <span className="animate-pulse mr-2 h-2 w-2 rounded-full bg-green-400 inline-block"></span>
              正在发言：{props.activeRoleId}
            </span>
          ) : null}
          {props.onStopGeneration && props.isStreaming ? (
            <button title="中断生成" onClick={props.onStopGeneration} className="icon-button danger">
              <Square size={18} />
            </button>
          ) : null}
          {props.onClear && props.chat ? (
            <button title="清空记录" onClick={props.onClear} className="icon-button">
              <Trash2 size={18} />
            </button>
          ) : null}
          {props.onDelete && props.chat ? (
            <button title="删除会话" onClick={props.onDelete} className="icon-button danger">
              <XCircle size={18} />
            </button>
          ) : null}
        </div>
      </div>

      <MessageList
        messages={props.messages}
        drafts={props.drafts}
        agentStatus={props.agentStatus}
        mediaUrls={mediaUrls}
        isStreaming={props.isStreaming}
        retryingAudioIds={retryingAudioIds}
        onRetryAudio={retryAudio}
        onEditAndRegenerate={props.onEditAndRegenerate}
        onRefreshMessages={props.onRefreshMessages}
      />

      {props.error ? <p className="error-text">{props.error}</p> : null}
      {!props.error && props.notice ? (
        <p style={{ margin: 0, color: "var(--theme-text-secondary, #7a7f87)" }}>{props.notice}</p>
      ) : null}
      {!props.error && props.finishedReason ? (
        <p style={{ margin: 0, color: "var(--theme-text-secondary, #7a7f87)" }}>结束原因：{props.finishedReason}</p>
      ) : null}
      {props.skippedRoles?.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {props.skippedRoles.map((item) => (
            <p key={`${item.roleId}-${item.reason}`} style={{ margin: 0, color: "var(--theme-text-secondary, #7a7f87)" }}>
              {item.message}
            </p>
          ))}
        </div>
      ) : null}

      <MessageComposer
        chatId={props.chat?.id ?? null}
        isStreaming={props.isStreaming}
        mentionTarget={props.mentionTarget}
        roomMode={props.chat?.mode === "group" ? effectiveRoomMode : null}
        onSend={handleSend}
        onAttachmentsChanged={setAttachmentDrafts}
      />
    </section>
  );
}
