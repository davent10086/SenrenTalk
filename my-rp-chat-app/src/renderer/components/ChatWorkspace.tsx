import { useEffect, useMemo, useState } from "react";
import { Brain, Check, Square, Trash2, XCircle } from "lucide-react";
import type {
  ChatMessage,
  ChatRecord,
  GroupChatRoomConfig,
  GroupChatRoomMode,
  GroupChatRoomState,
  GroupChatSkipReason,
  ChatMemorySnapshot,
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
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState<ChatMemorySnapshot | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const refreshMemories = async () => {
    if (!props.chat) return;
    try { setMemories(await apiClient.getMemories(props.chat.id)); setMemoryError(null); }
    catch (error) { setMemoryError(error instanceof Error ? error.message : "读取记忆失败"); }
  };

  useEffect(() => { if (memoryOpen) void refreshMemories(); }, [memoryOpen, props.chat?.id]);

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
          {props.chat ? (
            <button title="记忆" onClick={() => setMemoryOpen((value) => !value)} className="icon-button">
              <Brain size={18} />
            </button>
          ) : null}
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

      {memoryOpen && props.chat ? (
        <aside style={{ margin: "0 0 12px", padding: "12px", border: "1px solid var(--theme-border, #ddd)", borderRadius: "10px", maxHeight: "280px", overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><strong>记忆时间线</strong><button className="icon-button" onClick={() => void refreshMemories()} title="刷新"><Check size={16} /></button></div>
          {memoryError ? <p className="error-text">{memoryError}</p> : null}
          {memories?.coreMemories.map((core) => (
            <div key={core.id} style={{ marginTop: "8px", padding: "8px", background: "rgba(80,180,120,.10)", borderRadius: "6px" }}>
              <small>{core.character} 的当前核心记忆</small>
              <div>{[core.relationshipStage, ...core.keyFacts].filter(Boolean).join("；") || "暂无有效事实"}</div>
            </div>
          ))}
          {memories?.events.filter((event) => event.status === "pending").map((event) => (
            <div key={event.id} style={{ marginTop: "8px", padding: "8px", background: "rgba(250,180,60,.12)", borderRadius: "6px" }}>
              <small>待确认 · {event.eventType} · {event.occurredAt ? new Date(event.occurredAt).toLocaleString() : `于 ${new Date(event.recordedAt ?? event.timestamp).toLocaleString()} 提及`}</small>
              <div>{event.summary}</div>
              <button onClick={async () => { await apiClient.confirmMemory(props.chat!.id, event.id); await refreshMemories(); }}>确认</button>{" "}
              <button onClick={async () => { await apiClient.dismissMemory(props.chat!.id, event.id); await refreshMemories(); }}>忽略</button>
            </div>
          ))}
          {memories?.coreCandidates.map((candidate) => (
            <div key={candidate.id} style={{ marginTop: "8px", padding: "8px", background: "rgba(100,160,255,.12)", borderRadius: "6px" }}>
              <small>{candidate.character} 的核心记忆候选</small><div>{candidate.core.keyFacts.join("；") || candidate.core.relationshipStage}</div>
              <button onClick={async () => { await apiClient.confirmCoreMemory(props.chat!.id, candidate.character); await refreshMemories(); }}>确认</button>{" "}
              <button onClick={async () => { await apiClient.dismissCoreMemory(props.chat!.id, candidate.character); await refreshMemories(); }}>忽略</button>
            </div>
          ))}
          {memories?.events.filter((event) => event.status === "confirmed").map((event) => (
            <div key={event.id} style={{ marginTop: "8px", borderTop: "1px solid var(--theme-border, #ddd)", paddingTop: "7px" }}>
              <small>{event.temporalState} · {event.occurredAt ? new Date(event.occurredAt).toLocaleDateString() : `于 ${new Date(event.recordedAt ?? event.timestamp).toLocaleDateString()} 提及`}</small>
              <div>{event.summary}</div><button onClick={async () => { await apiClient.deleteMemory(props.chat!.id, event.id); await refreshMemories(); }}>删除</button>
            </div>
          ))}
          {memories && memories.events.length === 0 && memories.coreCandidates.length === 0 ? <p className="muted">暂无可管理的记忆。</p> : null}
        </aside>
      ) : null}

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
