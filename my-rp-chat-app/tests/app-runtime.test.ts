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
        repository: { clearMessages, getChat: vi.fn(() => ({ id: "chat-1" })) },
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

  it("does not clean media when the chat does not exist", async () => {
    const deleteMemoriesBySession = vi.fn();
    const clearMessages = vi.fn();
    const cleanupChatMedia = vi.fn();

    await expect(
      AppRuntime.prototype.clearMessages.call(
        {
          elasticsearchService: { deleteMemoriesBySession },
          repository: { clearMessages, getChat: vi.fn(() => undefined) },
          mediaManager: { cleanupChatMedia },
        },
        "../outside",
      ),
    ).rejects.toThrow(/Chat not found/);

    expect(deleteMemoriesBySession).not.toHaveBeenCalled();
    expect(clearMessages).not.toHaveBeenCalled();
    expect(cleanupChatMedia).not.toHaveBeenCalled();
  });
});
