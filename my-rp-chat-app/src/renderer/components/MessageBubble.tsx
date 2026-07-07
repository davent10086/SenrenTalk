import { motion } from "framer-motion";
import { User } from "lucide-react";
import { useState } from "react";
import type { ChatMessage, MessageAttachment } from "../../common/types";
import { AudioPlayer } from "./AudioPlayer";
import { getAvatarPath } from "../utils/avatar";

interface MessageBubbleProps {
  message: ChatMessage;
  mediaUrls: Record<string, string>;
  isStreaming?: boolean;
  isRetrying?: Record<string, boolean>;
  onRetryAudio?: (messageId: string) => Promise<void>;
  onEditAndRegenerate?: (messageId: string, content: string) => Promise<void>;
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
export function MessageBubble({
  message,
  mediaUrls,
  isStreaming,
  isRetrying,
  onRetryAudio,
  onEditAndRegenerate,
  onRefreshMessages,
}: MessageBubbleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const resolveAttachmentUrl = (attachment: MessageAttachment): string | undefined => {
    if (attachment.previewUrl) return attachment.previewUrl;
    if (attachment.relativePath) return mediaUrls[attachment.relativePath];
    return undefined;
  };

  const canEdit = message.role === "user" && !!onEditAndRegenerate && !isStreaming;

  const submitEdit = async () => {
    if (!onEditAndRegenerate || !editValue.trim() || isSubmittingEdit) return;
    const shouldContinue = window.confirm("确认保存这次编辑并重新生成吗？该消息之后的回复将被覆盖。");
    if (!shouldContinue) return;
    setIsSubmittingEdit(true);
    try {
      await onEditAndRegenerate(message.id, editValue.trim());
      setIsEditing(false);
    } finally {
      setIsSubmittingEdit(false);
    }
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
            {message.role === "assistant" && message.metadata?.replyToRoleId ? (
              <span style={{ color: "var(--theme-text-secondary)", fontSize: "0.8rem" }}>
                回应给 @{message.metadata.replyToRoleId}
              </span>
            ) : null}
            {canEdit ? (
              <button
                type="button"
                onClick={() => {
                  setEditValue(message.content);
                  setIsEditing((current) => !current);
                }}
                style={{
                  marginLeft: "8px",
                  border: "none",
                  background: "transparent",
                  color: "var(--theme-primary)",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                }}
              >
                {isEditing ? "取消编辑" : "编辑后重生成"}
              </button>
            ) : null}
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
          {isEditing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <textarea
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                rows={4}
                style={{
                  width: "100%",
                  resize: "vertical",
                  borderRadius: "10px",
                  border: "1px solid var(--theme-border)",
                  background: "var(--theme-surface)",
                  color: "var(--theme-text)",
                  padding: "10px 12px",
                }}
              />
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button type="button" className="icon-button" onClick={() => setIsEditing(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!editValue.trim() || isSubmittingEdit}
                  onClick={() => void submitEdit()}
                >
                  保存并重生成
                </button>
              </div>
            </div>
          ) : (
            message.content.split("\n").map((line, i) => (
              <p key={i}>{line || "\u00A0"}</p>
            ))
          )}

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
