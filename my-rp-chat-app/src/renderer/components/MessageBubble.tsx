import { motion } from "framer-motion";
import { User } from "lucide-react";
import type { ChatMessage, MessageAttachment } from "../../common/types";
import { AudioPlayer } from "./AudioPlayer";
import { getAvatarPath } from "../utils/avatar";

interface MessageBubbleProps {
  message: ChatMessage;
  mediaUrls: Record<string, string>;
  isRetrying?: Record<string, boolean>;
  onRetryAudio?: (messageId: string) => Promise<void>;
  onRefreshMessages?: () => Promise<void>;
}

/**
 * 单条消息气泡组件。
 *
 * 处理三种类型的内容：
 * 1. 图片附件（attachment 缩略图）
 * 2. 文本消息内容
 * 3. 语音播放器（仅 assistant 消息）
 *
 * 用户消息来自右对齐，assistant 消息左对齐带角色头像。
 */
export function MessageBubble({ message, mediaUrls, isRetrying, onRetryAudio, onRefreshMessages }: MessageBubbleProps) {
  const resolveAttachmentUrl = (attachment: MessageAttachment): string | undefined => {
    if (attachment.previewUrl) return attachment.previewUrl;
    if (attachment.relativePath) return mediaUrls[attachment.relativePath];
    return undefined;
  };

  return (
    <motion.div
      className={`message-wrapper ${message.role}`}
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 25, mass: 1.2 }}
      layout="position"
    >
      <article className="message-bubble">
        <div className="message-avatar">
          {message.role === "assistant" ? (
            <img src={getAvatarPath(message.roleId)} alt={message.roleId ?? "助手"} />
          ) : (
            <User size={24} />
          )}
        </div>
        <div className="message-content-wrapper">
          <header className="message-header">
            <strong>{message.role === "assistant" ? message.roleId ?? "助手" : "用户"}</strong>
            <span>{new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
          </header>

          {/* 附件图片 */}
          {message.metadata?.attachments?.length ? (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
              {message.metadata.attachments.map((attachment) => {
                const attachmentUrl = resolveAttachmentUrl(attachment);
                if (!attachmentUrl) return null;
                return (
                  <img
                    key={attachment.id}
                    src={attachmentUrl}
                    alt={attachment.originalName}
                    style={{
                      width: "140px",
                      height: "140px",
                      objectFit: "cover",
                      borderRadius: "12px",
                      border: "1px solid var(--theme-border)",
                    }}
                  />
                );
              })}
            </div>
          ) : null}

          {/* 消息文本 */}
          {message.content.split("\n").map((line, i) => (
            <p key={i}>{line || "\u00A0"}</p>
          ))}

          {/* 语音播放器 */}
          {message.metadata?.audio ? (
            <AudioPlayer
              audio={message.metadata.audio}
              mediaUrl={
                message.metadata.audio.relativePath
                  ? mediaUrls[message.metadata.audio.relativePath]
                  : undefined
              }
              messageId={message.id}
              isRetrying={isRetrying?.[message.id]}
              onRetry={onRetryAudio}
              onRefresh={onRefreshMessages}
            />
          ) : null}
        </div>
      </article>
    </motion.div>
  );
}
