﻿import { useViewContext } from "../context/ViewContext";
import { useChatContext } from "../context/ChatContext";
import { ChatWorkspace } from "../components/ChatWorkspace";

export function GroupChatPage() {
  const { activeChat, mentionTarget, setMentionTarget } = useViewContext();
  const { messages, drafts, agentStatus, activeRoleId, isStreaming, streamError, sendMessage, refreshMessages, retryAudio, clearChat, deleteChat } = useChatContext();

  return (
    <ChatWorkspace
      title="多角色群聊"
      chat={activeChat}
      messages={messages}
      drafts={drafts}
      agentStatus={agentStatus}
      activeRoleId={activeRoleId}
      isStreaming={isStreaming}
      error={streamError}
      mentionTarget={mentionTarget}
      onSend={sendMessage}
      onRefreshMessages={refreshMessages}
      onRetryAudio={retryAudio}
      onClear={clearChat}
      onDelete={deleteChat}
      headerExtra={
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>定向发言</span>
          <select
            value={mentionTarget ?? ""}
            onChange={(e) => setMentionTarget(e.target.value || null)}
            style={{ padding: "4px 8px", fontSize: "0.85rem", borderRadius: "6px", background: "var(--theme-surface)", border: "1px solid var(--theme-border)", color: "var(--theme-text)" }}
          >
            <option value="">轮流发言</option>
            {activeChat?.participants.map((p) => (
              <option key={p} value={p}>@{p}</option>
            ))}
          </select>
        </div>
      }
    />
  );
}
