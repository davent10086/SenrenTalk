/**
 * Media resource manager.
 *
 * Owns attachment persistence, media URL resolution, and media file cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "./config";
import type { MessageAttachment, PendingAttachmentInput } from "../common/types";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function assertSafePathSegment(value: string, label: string): string {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw badRequest(`Invalid ${label}`);
  }
  return value;
}

function safeExtension(originalName: string): string {
  const extension = path.extname(originalName).toLowerCase();
  return SAFE_EXTENSION.test(extension) ? extension : ".bin";
}

function resolveWithin(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw badRequest("Media path escapes configured media directory");
}

export class MediaManager {
  constructor(private readonly config: AppConfig) {}

  async persistAttachments(
    chatId: string,
    messageId: string,
    attachments: PendingAttachmentInput[],
  ): Promise<MessageAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    const safeChatId = assertSafePathSegment(chatId, "chatId");
    const safeMessageId = assertSafePathSegment(messageId, "messageId");
    const chatImageDir = resolveWithin(this.config.mediaDir, path.join("images", safeChatId));
    await fs.mkdir(chatImageDir, { recursive: true });

    return Promise.all(
      attachments.map(async (attachment) => {
        if (!attachment.absolutePath) {
          throw new Error(`Attachment ${attachment.originalName} is missing a readable local path`);
        }

        const safeAttachmentId = assertSafePathSegment(attachment.id, "attachmentId");
        const extension = safeExtension(attachment.originalName);
        const fileName = `${safeMessageId}-${safeAttachmentId}${extension}`;
        const absoluteTarget = resolveWithin(chatImageDir, fileName);

        await fs.copyFile(attachment.absolutePath, absoluteTarget);
        return {
          id: attachment.id,
          kind: attachment.kind,
          originalName: attachment.originalName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          relativePath: path.posix.join("images", safeChatId, fileName),
          width: attachment.width,
          height: attachment.height,
          durationMs: attachment.durationMs,
        };
      }),
    );
  }

  resolveMediaUrl(relativePath: string): string {
    return pathToFileURL(this.resolveMediaPath(relativePath)).href;
  }

  resolveMediaPath(relativePath: string): string {
    return resolveWithin(this.config.mediaDir, relativePath);
  }

  async cleanupChatMedia(chatId: string): Promise<void> {
    const safeChatId = assertSafePathSegment(chatId, "chatId");
    const subDirs = ["images", "audio"].map((sub) =>
      resolveWithin(this.config.mediaDir, path.join(sub, safeChatId)),
    );

    await Promise.all(
      subDirs.map(async (dir) => {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (error) {
          console.warn(`[MediaManager] Failed to clean media directory ${dir}:`, error);
        }
      }),
    );
  }

  async cleanupRelativePaths(relativePaths: string[]): Promise<void> {
    const uniquePaths = [...new Set(relativePaths.filter(Boolean))];
    await Promise.all(
      uniquePaths.map(async (relativePath) => {
        try {
          await fs.rm(this.resolveMediaPath(relativePath), { force: true });
        } catch (error) {
          console.warn(`[MediaManager] Failed to clean media file ${relativePath}:`, error);
        }
      }),
    );
  }
}
