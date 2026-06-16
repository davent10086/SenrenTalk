import { useRef, useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ChatMessage } from "../../common/types";
import { MessageBubble } from "./MessageBubble";
import { getAvatarPath } from "../utils/avatar";

interface DraftEntry {
  roleId: string;
  content: string;
  agentStatus: string;
}

interface MessageListProps {
  messages: ChatMessage[];
  drafts: Record<string, string>;
  agentStatus: Record<string, string>;
  mediaUrls: Record<string, string>;
  retryingAudioIds: Record<string, boolean>;
  onRetryAudio?: (messageId: string) => Promise<void>;
  onRefreshMessages?: () => Promise<void>;
}

/**
 * 消息列㿟组件。
 *
 * 渲染所有已确认的消息和正在流式生成的草稿消息。
 * 使用 AnimatePresence 实现消息进入/退出的动画。
 * 自动滚动到最新消息。
 */
export function MessageList({
  messages, drafts, agentStatus, mediaUrls,
  retryingAudioIds, onRetryAudio, onRefreshMessages,
}: MessageListProps) {
  const logRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, drafts]);

  // 将 draft 对象转为有序数组
  const draftEntries = useMemo<DraftEntry[]>(
    () =>
      Object.entries(drafts).map(([roleId, content]) => ({
        roleId,
        content,
        agentStatus: agentStatus[roleId] ?? "正在思考与回忆...",
      })),
    [drafts, agentStatus],
  );

  return (
    <div className="chat-log" ref={logRef}>
      <div style={{ flex: 1, minHeight: "20px" }}></div>
      <AnimatePresence initial={false}>
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            mediaUrls={mediaUrls}
            isRetrying={retryingAudioIds}
            onRetryAudio={onRetryAudio}
            onRefreshMessages={onRefreshMessages}
          />
        ))}

        {draftEntries.map(({ roleId, content, agentStatus: status }) => (
          <motion.div
            className="message-wrapper assistant"
            key={roleId}
            initial={{ opacity: 0, y: 15, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            layout="position"
          >
            <article className="message-bubble draft">
              <div className="message-avatar">
                <img src={getAvatarPath(roleId)} alt={roleId === "__default__" ? "助手" : roleId} />
              </div>
              <div className="message-content-wrapper">
                <header className="message-header">
                  <strong>{roleId === "__default__" ? "助手" : roleId}</strong>
                  <span className="animate-pulse" style={{ color: "var(--theme-primary)", fontWeight: 500 }}>
                    {content.trim() ? "正在输入回复..." : status}
                  </span>
                </header>
                {content ? (
                  content.split("\n").map((line, i) => <p key={i}>{line || "\u00A0"}</p>)
                ) : (
                  <div style={{ display: "flex", gap: "4px", padding: "8px 0" }}>
                    <span className="typing-dot"></span>
                    <span className="typing-dot" style={{ animationDelay: "0.2s" }}></span>
                    <span className="typing-dot" style={{ animationDelay: "0.4s" }}></span>
                  </div>
                )}
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  transition={{ duration: 0.3 }}
                  style={{ marginTop: "12px", overflow: "hidden" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", padding: "4px 0" }}>
                    <div className="audio-wave-loader" style={{ opacity: 0.5 }}>
                      <span></span><span></span><span></span><span></span>
                    </div>
                    <span className="muted" style={{ fontSize: "0.85rem", opacity: 0.7 }}>
                      等待文本完成以合成语音...
                    </span>
                  </div>
                </motion.div>
              </div>
            </article>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
