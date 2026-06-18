import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BackendJob, ChatMessage, ChatMessageMetadata } from "../../common/types";
import * as apiClient from "../api/client";
import { useChatStream } from "../hooks/useChatStream";
import { useViewContext } from "./ViewContext";
import type { PendingAttachmentDraft } from "../types";

interface ChatContextValue {
  messages: ChatMessage[];
  jobs: BackendJob[];
  drafts: Record<string, string>;
  agentStatus: Record<string, string>;
  activeRoleId: string | null;
  isStreaming: boolean;
  streamError: string | null;
  sendMessage: (content: string, mentionTarget?: string | null, attachments?: PendingAttachmentDraft[]) => Promise<void>;
  refreshMessages: () => Promise<void>;
  clearChat: () => Promise<void>;
  deleteChat: () => Promise<void>;
  retryAudio: (messageId: string) => Promise<void>;
  rebuildIndex: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  resetStream: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { activeChatId, activeChat, deleteChat: removeChat } = useViewContext();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [jobs, setJobs] = useState<BackendJob[]>([]);

  const refreshMessages = useCallback(async () => {
    if (!activeChatId) { setMessages([]); return; }
    setMessages(await apiClient.listMessages(activeChatId));
  }, [activeChatId]);

  const refreshJobs = useCallback(async () => {
    setJobs(await apiClient.listJobs());
  }, []);

  const { drafts, agentStatus, activeRoleId, isStreaming, error: streamError, sendMessage: streamSend, resetStream } =
    useChatStream({ onMessagesChanged: async () => { await refreshMessages(); } });

  useEffect(() => { void refreshMessages(); }, [refreshMessages]);

  const { currentView } = useViewContext();
  useEffect(() => {
    if (currentView !== "settings") return;
    void refreshJobs();
    const timer = window.setInterval(() => void refreshJobs(), 1500);
    return () => window.clearInterval(timer);
  }, [currentView, refreshJobs]);

  const sendMessage = useCallback(async (
    content: string,
    mentionTarget?: string | null,
    attachments: PendingAttachmentDraft[] = [],
  ) => {
    if (!activeChat) return;
    const normalizedContent = content.trim() || (attachments.length > 0 ? "[图片]" : "");

    // Optimistic UI update
    const optimisticMetadata: ChatMessageMetadata | undefined = attachments.length > 0
      ? { attachments: attachments.map((a) => ({ id: a.id, kind: a.kind, originalName: a.originalName, mimeType: a.mimeType, size: a.size, relativePath: "", width: a.width, height: a.height, durationMs: a.durationMs, previewUrl: a.previewUrl })) }
      : undefined;
    const optimisticMessage: ChatMessage = {
      id: `temp-${Date.now()}`, chatId: activeChat.id, role: "user", roleId: null,
      content: normalizedContent, timestamp: Date.now(), metadata: optimisticMetadata,
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    await streamSend({
      chatId: activeChat.id,
      content: normalizedContent,
      mode: activeChat.mode,
      participants: activeChat.participants,
      mentionTarget: mentionTarget ?? null,
      attachments,
    });
  }, [activeChat, streamSend]);

  const clearChat = useCallback(async () => {
    if (!activeChatId) return;
    if (!window.confirm("确定要清空当前会话的聊天记录吗？这也会清空该会话相关的记忆。")) return;
    resetStream();
    await apiClient.clearMessages(activeChatId);
    await refreshMessages();
  }, [activeChatId, refreshMessages, resetStream]);

  const deleteChat = useCallback(async () => {
    if (!activeChatId) return;
    if (!window.confirm("确定要删除当前会话吗？这将永久删除该会话的所有聊天记录和记忆，且无法恢复。")) return;
    resetStream();
    // ViewContext.deleteChat 负责 API 调用、导航和会话列表刷新
    // ChatContext 不再重复调用 apiClient.deleteChat，避免同一会话被删除两次
    await removeChat(activeChatId);
  }, [activeChatId, resetStream, removeChat]);

  const retryAudio = useCallback(async (messageId: string) => {
    await apiClient.regenerateMessageAudio(messageId);
    await refreshMessages();
  }, [refreshMessages]);

  const rebuildIndex = useCallback(async () => {
    await apiClient.startDialogueIndexJob();
    await refreshJobs();
  }, [refreshJobs]);

  const value = useMemo<ChatContextValue>(() => ({
    messages, jobs, drafts, agentStatus, activeRoleId, isStreaming, streamError,
    sendMessage, refreshMessages, clearChat, deleteChat, retryAudio, rebuildIndex, refreshJobs, resetStream,
  }), [messages, jobs, drafts, agentStatus, activeRoleId, isStreaming, streamError,
      sendMessage, refreshMessages, clearChat, deleteChat, retryAudio, rebuildIndex, refreshJobs, resetStream]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatContext must be used within a ChatProvider");
  return ctx;
}
