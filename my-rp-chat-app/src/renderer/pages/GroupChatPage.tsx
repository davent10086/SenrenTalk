import { ChatWorkspace } from "../components/ChatWorkspace";
import { useChatContext } from "../context/ChatContext";
import { useViewContext } from "../context/ViewContext";
import { createGroupChatRoomConfigForMode, type GroupChatRoomMode } from "../../common/types";

export function GroupChatPage() {
  const [pendingHostSelection, setPendingHostSelection] = useState(false);
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
  const participantCount = activeChat?.participants.length ?? 0;
  const hostRoleId = activeChat?.roomConfig?.hostRoleId ?? "";
  const validHost = Boolean(hostRoleId && activeChat?.participants.includes(hostRoleId));
  const hostMode = activeChat?.roomConfig?.mode === "host_mode";

  const handleModeChange = (nextMode: GroupChatRoomMode) => {
    if (nextMode === "host_mode" && !validHost) {
      setPendingHostSelection(true);
      return;
    }
    setPendingHostSelection(false);
    const defaults = createGroupChatRoomConfigForMode(participantCount, nextMode);
    void updateGroupChatRoom({
      roomConfig: {
        mode: nextMode,
        maxRounds: defaults.maxRounds,
        maxMessages: defaults.maxMessages,
      },
      roomState: {
        currentRound: 0,
        currentTurn: 0,
        plannedSpeakers: [],
        lastSpeakers: [],
        skippedRoles: [],
        lastFinishedReason: undefined,
      },
    });
  };

  return (
    <ChatWorkspace
      title="多角色群聊"
      chat={activeChat}
      messages={messages}
      drafts={drafts}
      agentStatus={agentStatus}
      activeRoleId={activeRoleId}
      isStreaming={isStreaming}
      error={hostMode && !validHost ? "请先选择房间内的主持角色。" : streamError}
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
            value={pendingHostSelection ? "host_mode" : activeChat?.roomConfig?.mode ?? "single_round"}
            onChange={(event) => handleModeChange(event.target.value as GroupChatRoomMode)}
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
          {pendingHostSelection || hostMode ? (
            <select
              aria-label="选择主持角色"
              value={validHost ? hostRoleId : ""}
              onChange={(event) => {
                const selectedHost = event.target.value;
                if (!selectedHost) return;
                const defaults = createGroupChatRoomConfigForMode(participantCount, "host_mode");
                void updateGroupChatRoom({
                  roomConfig: {
                    mode: "host_mode",
                    hostRoleId: selectedHost,
                    maxRounds: defaults.maxRounds,
                    maxMessages: defaults.maxMessages,
                  },
                });
                setPendingHostSelection(false);
              }}
            >
              <option value="">选择主持角色</option>
              {activeChat?.participants.map((participant) => (
                <option key={participant} value={participant}>{participant}</option>
              ))}
            </select>
          ) : null}
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
import { useState } from "react";
