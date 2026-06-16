import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import type { MessageAudio } from "../../common/types";

interface AudioPlayerProps {
  audio: MessageAudio;
  mediaUrl?: string;
  messageId: string;
  isRetrying?: boolean;
  onRetry?: (messageId: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
}

/**
 * 消息音频播放器组件。
 *
 * 根据音频状态渲染不同的 UI：
 * - pending: 加载中动画 + 手动刷新按钮
 * - failed: 错误信息 + 重试按钮
 * - ready: 原生 <audio> 控件
 */
export function AudioPlayer({ audio, mediaUrl, messageId, isRetrying, onRetry, onRefresh }: AudioPlayerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, height: "auto", filter: "blur(0px)" }}
      transition={{ duration: 0.4, delay: 0.15, ease: "easeOut" }}
      style={{ marginTop: "12px", overflow: "hidden" }}
    >
      {audio.status === "pending" ? (
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", padding: "4px 0" }}>
          <div className="audio-wave-loader">
            <span></span><span></span><span></span><span></span>
          </div>
          <span className="muted" style={{ color: "var(--theme-primary)", fontWeight: 500, fontSize: "0.85rem" }}>
            正在合成角色语音...
          </span>
          {onRefresh ? (
            <button
              className="secondary-button"
              onClick={() => void onRefresh()}
              style={{ padding: "4px 10px", fontSize: "0.85rem", minHeight: "auto" }}
            >
              <RefreshCw size={14} />
              手动刷新
            </button>
          ) : null}
        </div>
      ) : null}

      {audio.status === "failed" ? (
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <span className="error-text" style={{ margin: 0 }}>
            语音生成失败：{audio.error ?? "未知错误"}
          </span>
          {onRetry ? (
            <button
              className="secondary-button"
              onClick={() => void onRetry(messageId)}
              disabled={isRetrying}
              style={{ padding: "4px 10px", fontSize: "0.85rem", minHeight: "auto" }}
            >
              <RefreshCw size={14} />
              {isRetrying ? "重试中..." : "重试语音"}
            </button>
          ) : null}
        </div>
      ) : null}

      {audio.status === "ready" && audio.relativePath && mediaUrl ? (
        <audio controls src={mediaUrl} style={{ width: "100%" }} />
      ) : null}
    </motion.div>
  );
}
