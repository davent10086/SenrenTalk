import { useState, useRef } from "react";
import { ImagePlus, Send } from "lucide-react";
import type { PendingAttachmentDraft } from "../types";

interface MessageComposerProps {
  chatId: string | null;
  isStreaming: boolean;
  mentionTarget?: string | null;
  placeholder?: string;
  onSend: (content: string) => Promise<void>;
  onAttachmentsChanged: (attachments: PendingAttachmentDraft[]) => void;
}

/**
 * 消息输入区组件。
 *
 * 包含：
 * - 附件添加按钮（图片上传）
 * - 多行文本输入框（Enter 发送，Shift+Enter 换行）
 * - 发送按钮
 * - 待发送附件预览缩略图
 */
export function MessageComposer({
  chatId, isStreaming, mentionTarget, placeholder, onSend, onAttachmentsChanged,
}: MessageComposerProps) {
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentDraft[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitMessage();
    }
  };

  const submitMessage = async () => {
    if (!chatId || isStreaming) return;
    const content = input.trim();
    if (!content && pendingAttachments.length === 0) return;
    setInput("");
    await onSend(content);
    pendingAttachments.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
  };

  const pickAttachments = () => {
    if (!chatId || isStreaming) return;
    fileInputRef.current?.click();
  };

  const handleAttachmentChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    const picked = await Promise.all(
      files.map(async (file) => {
        const previewUrl = URL.createObjectURL(file);
        return {
          id: window.crypto.randomUUID(),
          kind: "image" as const,
          originalName: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          previewUrl,
          file,
        };
      }),
    );

    const next = [...pendingAttachments, ...picked];
    setPendingAttachments(next);
    onAttachmentsChanged(next);
    event.target.value = "";
  };

  const removePendingAttachment = (attachmentId: string) => {
    setPendingAttachments((current) => {
      const target = current.find((a) => a.id === attachmentId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((a) => a.id !== attachmentId);
    });
  };

  const defaultPlaceholder = mentionTarget
    ? `可直接输入内容，当前 @${mentionTarget} (按 Enter 发送)`
    : "输入消息... (按 Enter 发送，Shift+Enter 换行)";

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => void handleAttachmentChange(event)}
      />

      {/* 待发送附件缩略图 */}
      {pendingAttachments.length > 0 ? (
        <div style={{ display: "flex", gap: "10px", padding: "0 24px 12px", flexWrap: "wrap" }}>
          {pendingAttachments.map((attachment) => (
            <div
              key={attachment.id}
              style={{
                position: "relative",
                width: "100px",
                height: "100px",
                borderRadius: "12px",
                overflow: "hidden",
                border: "1px solid var(--theme-border)",
                background: "var(--theme-surface)",
              }}
            >
              <img
                src={attachment.previewUrl}
                alt={attachment.originalName}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <button
                title="移除图片"
                onClick={() => removePendingAttachment(attachment.id)}
                style={{
                  position: "absolute",
                  top: "6px",
                  right: "6px",
                  border: "none",
                  borderRadius: "999px",
                  width: "24px",
                  height: "24px",
                  display: "grid",
                  placeItems: "center",
                  background: "rgba(0, 0, 0, 0.65)",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="composer-container">
        <div className="composer">
          <button
            title="添加图片"
            className="icon-button"
            disabled={!chatId || isStreaming}
            onClick={pickAttachments}
          >
            <ImagePlus size={18} />
          </button>
          <textarea
            placeholder={placeholder ?? defaultPlaceholder}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!chatId || isStreaming}
          />
          <button
            title="发送消息"
            className="primary-button"
            disabled={!chatId || (!input.trim() && pendingAttachments.length === 0) || isStreaming}
            onClick={submitMessage}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </>
  );
}

