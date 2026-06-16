import { useViewContext } from "../context/ViewContext";
import { useChatContext } from "../context/ChatContext";
import { ChatWorkspace } from "../components/ChatWorkspace";

export function SingleChatPage() {
  const { activeChat } = useViewContext();
  const { messages, drafts, agentStatus, activeRoleId, isStreaming, streamError, sendMessage, refreshMessages, retryAudio, clearChat, deleteChat } = useChatContext();

  return (
    <ChatWorkspace
      title="单角色聊天"
      chat={activeChat}
      messages={messages}
      drafts={drafts}
      agentStatus={agentStatus}
      activeRoleId={activeRoleId}
      isStreaming={isStreaming}
      error={streamError}
      onSend={async (content, _mentionTarget, attachments) => sendMessage(content, null, attachments)}
      onRefreshMessages={refreshMessages}
      onRetryAudio={retryAudio}
      onClear={clearChat}
      onDelete={deleteChat}
    />
  );
}
