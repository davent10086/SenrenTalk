/**
 * 媒体资源管理器
 *
 * 负责附件持久化、媒体路径解析、文件操作。
 * 从 AppRuntime 中提取，职责单一。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "./config";
import type { MessageAttachment, PendingAttachmentInput } from "../common/types";

export class MediaManager {
  constructor(private readonly config: AppConfig) {}

  /**
   * 将用户上传的附件复制到 mediaDir/images/{chatId}/ 目录，
   * 返回可用于持久化到数据库的相对路径信息。
   */
  async persistAttachments(
    chatId: string,
    messageId: string,
    attachments: PendingAttachmentInput[],
  ): Promise<MessageAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    const chatImageDir = path.join(this.config.mediaDir, "images", chatId);
    await fs.mkdir(chatImageDir, { recursive: true });

    return Promise.all(
      attachments.map(async (attachment) => {
        if (!attachment.absolutePath) {
          throw new Error(`附件 ${attachment.originalName} 缺少可读取的本地路径`);
        }
        const extension = path.extname(attachment.originalName) || ".bin";
        const fileName = `${messageId}-${attachment.id}${extension}`;
        const absoluteTarget = path.join(chatImageDir, fileName);
        await fs.copyFile(attachment.absolutePath, absoluteTarget);
        return {
          id: attachment.id,
          kind: attachment.kind,
          originalName: attachment.originalName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          relativePath: path.posix.join("images", chatId, fileName),
          width: attachment.width,
          height: attachment.height,
          durationMs: attachment.durationMs,
        };
      }),
    );
  }

  /** 将媒体相对路径转为 file:// URL。 */
  resolveMediaUrl(relativePath: string): string {
    return pathToFileURL(path.join(this.config.mediaDir, relativePath)).href;
  }

  /**
   * 清理指定会话的所有媒体文件（图片和音频）。
   * 按 chatId 分目录存储，直接删除 images/{chatId} 和 audio/{chatId} 两个目录。
   * 尽力而为：即使文件删除失败也不抛出，仅记录警告，避免阻塞会话清理。
   */
  async cleanupChatMedia(chatId: string): Promise<void> {
    const subDirs = ["images", "audio"].map((sub) => path.join(this.config.mediaDir, sub, chatId));
    await Promise.all(
      subDirs.map(async (dir) => {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (error) {
          console.warn(`[MediaManager] 清理媒体目录失败 ${dir}:`, error);
        }
      }),
    );
  }
}
