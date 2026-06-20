import { describe, expect, it, vi } from "vitest";
import { AppRuntime } from "../src/backend/app-runtime";

describe("AppRuntime.clearMessages", () => {
  it("deletes elasticsearch memories before clearing sqlite records, then cleans up media", async () => {
    const steps: string[] = [];
    const deleteMemoriesBySession = vi.fn(async (chatId: string) => {
      steps.push(`es:${chatId}`);
    });
    const clearMessages = vi.fn((chatId: string) => {
      steps.push(`sqlite:${chatId}`);
    });
    const cleanupChatMedia = vi.fn(async (chatId: string) => {
      steps.push(`media:${chatId}`);
    });

    await AppRuntime.prototype.clearMessages.call(
      {
        elasticsearchService: { deleteMemoriesBySession },
        repository: { clearMessages },
        mediaManager: { cleanupChatMedia },
      },
      "chat-1",
    );

    expect(deleteMemoriesBySession).toHaveBeenCalledWith("chat-1");
    expect(clearMessages).toHaveBeenCalledWith("chat-1");
    expect(cleanupChatMedia).toHaveBeenCalledWith("chat-1");
    // 顺序：ES 记忆 → SQLite 记录 → 媒体文件
    expect(steps).toEqual(["es:chat-1", "sqlite:chat-1", "media:chat-1"]);
  });
});
