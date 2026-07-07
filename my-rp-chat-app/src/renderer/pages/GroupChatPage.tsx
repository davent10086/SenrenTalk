import { ChatWorkspace } from "../components/ChatWorkspace";
import { useChatContext } from "../context/ChatContext";
import { useViewContext } from "../context/ViewContext";

export function GroupChatPage() {
  const { activeChat, updateGroupChatRoom } = useViewContext();
  const {
    messages,
    drafts,
    agentStatus,
    activeRoleId,
    isStreaming,
    streamError,
    streamNotice,
    currentRound,
    plannedSpeakers,
    skippedRoles,
    finishedReason,
    roomMode,
    targetRoleId,
    sendMessage,
    updateGroupChatRoom: updateRoomFromChat,
    editMessageAndRegenerate,
    stopGeneration,
    refreshMessages,
    retryAudio,
    clearChat,
    deleteChat,
  } = useChatContext();

  const effectiveTarget = targetRoleId ?? activeChat?.roomConfig?.targetRoleId ?? null;

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
      notice={streamNotice}
      mentionTarget={effectiveTarget}
      currentRound={currentRound}
      plannedSpeakers={plannedSpeakers}
      skippedRoles={skippedRoles}
      finishedReason={finishedReason}
      roomMode={roomMode}
      onSend={sendMessage}
      onUpdateRoom={updateRoomFromChat}
      onRefreshMessages={refreshMessages}
      onRetryAudio={retryAudio}
      onEditAndRegenerate={editMessageAndRegenerate}
      onStopGeneration={stopGeneration}
      onClear={clearChat}
      onDelete={deleteChat}
      headerExtra={
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <select
            value={activeChat?.roomConfig?.mode ?? "single_round"}
            onChange={(event) => void updateGroupChatRoom({
              roomConfig: { mode: event.target.value as "single_round" | "free_chat" | "host_mode" },
            })}
            style={{
              padding: "4px 8px",
              fontSize: "0.85rem",
              borderRadius: "6px",
              background: "var(--theme-surface)",
              border: "1px solid var(--theme-border)",
              color: "var(--theme-text)",
            }}
          >
            <option value="single_round">一轮回应</option>
            <option value="free_chat">自由群聊</option>
            <option value="host_mode">主持模式</option>
          </select>
          <select
            value={effectiveTarget ?? ""}
            onChange={(event) => void updateGroupChatRoom({
              roomConfig: { targetRoleId: event.target.value || null },
              roomState: { lastTargetRoleId: event.target.value || null },
            })}
            style={{
              padding: "4px 8px",
              fontSize: "0.85rem",
              borderRadius: "6px",
              background: "var(--theme-surface)",
              border: "1px solid var(--theme-border)",
              color: "var(--theme-text)",
            }}
          >
            <option value="">让大家都说一句</option>
            {activeChat?.participants.map((participant) => (
              <option key={participant} value={participant}>
                只让 @{participant} 回复
              </option>
            ))}
          </select>
        </div>
      }
    />
  );
}
