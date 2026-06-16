﻿import { useMemo, useEffect, useState } from "react";
import { Trash2, XCircle } from "lucide-react";
import type { ChatMessage, ChatRecord } from "../../common/types";
import * as apiClient from "../api/client";
import type { PendingAttachmentDraft } from "../types";
import { MessageList } from "./MessageList";
import { MessageComposer } from "./MessageComposer";

interface ChatWorkspaceProps {
  title: string;
  chat: ChatRecord | null;
  messages: ChatMessage[];
  drafts: Record<string, string>;
  agentStatus: Record<string, string>;
  activeRoleId: string | null;
  isStreaming: boolean;
  error: string | null;
  mentionTarget?: string | null;
  headerExtra?: React.ReactNode;
  onSend: (
    content: string,
    mentionTarget?: string | null,
    attachments?: PendingAttachmentDraft[],
  ) => Promise<void>;
  onRefreshMessages?: () => Promise<void>;
  onRetryAudio?: (messageId: string) => Promise<void>;
  onClear?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}

/**
 * 聊天工作区主组件。
 *
 * 从左到右的布局：
 * 1. 顶部栏（标题 + 角色状态 + 清空按钮）
 * 2. 消息列���（MessageList）
 * 3. 输入区（MessageComposer）
 */
export function ChatWorkspace(props: ChatWorkspaceProps) {
  const [retryingAudioIds, setRetryingAudioIds] = useState<Record<string, boolean>>({});
  const [attachmentDrafts, setAttachmentDrafts] = useState<PendingAttachmentDraft[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  // 收集消息中需要加载的媒体文件路径
  const mediaPaths = useMemo(() => {
    const paths = new Set<string>();
    props.messages.forEach((message) => {
      message.metadata?.attachments?.forEach((attachment) => {
        if (attachment.relativePath) paths.add(attachment.relativePath);
      });
      if (message.metadata?.audio?.relativePath) {
        paths.add(message.metadata.audio.relativePath);
      }
    });
    return [...paths];
  }, [props.messages]);

  // 批量加载媒体 URL
  useEffect(() => {
    const missing = mediaPaths.filter((relativePath) => !mediaUrls[relativePath]);
    if (missing.length === 0) return;
    setMediaUrls((current) => ({
      ...current,
      ...Object.fromEntries(
        missing.map((relativePath) => [relativePath, apiClient.resolveMediaUrl(relativePath)]),
      ),
    }));
  }, [mediaPaths, mediaUrls]);

  const retryAudio = async (messageId: string) => {
    if (!props.onRetryAudio || retryingAudioIds[messageId]) return;
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

  return (
    <section className="page chat-page">
      {/* 顶部栏 */}
      <div className="chat-header">
        <div>
          <h2>{props.title}</h2>
          <p>{props.chat ? props.chat.title : "请先创建或选择会话"}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {props.headerExtra}
          {props.activeRoleId ? (
            <span className="badge playable">
              <span className="animate-pulse mr-2 h-2 w-2 rounded-full bg-green-400 inline-block"></span>
              正在发言：{props.activeRoleId}
            </span>
          ) : null}
          {props.onClear && props.chat && (
            <button title="清空记录" onClick={props.onClear} className="icon-button">
              <Trash2 size={18} />
            </button>
          )}
          {props.onDelete && props.chat && (
            <button title="删除会话" onClick={props.onDelete} className="icon-button danger">
              <XCircle size={18} />
            </button>
          )}
        </div>
      </div>

      {/* 消息列�� */}
      <MessageList
        messages={props.messages}
        drafts={props.drafts}
        agentStatus={props.agentStatus}
        mediaUrls={mediaUrls}
        retryingAudioIds={retryingAudioIds}
        onRetryAudio={retryAudio}
        onRefreshMessages={props.onRefreshMessages}
      />

      {/* 错误提示 */}
      {props.error ? <p className="error-text">{props.error}</p> : null}

      {/* 输入区 */}
      <MessageComposer
        chatId={props.chat?.id ?? null}
        isStreaming={props.isStreaming}
        mentionTarget={props.mentionTarget}
        onSend={handleSend}
        onAttachmentsChanged={setAttachmentDrafts}
      />
    </section>
  );
}

