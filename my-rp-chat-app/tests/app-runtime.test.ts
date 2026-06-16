import { describe, expect, it, vi } from "vitest";
import { AppRuntime } from "../src/backend/app-runtime";

describe("AppRuntime.clearMessages", () => {
  it("deletes elasticsearch memories before clearing sqlite records", async () => {
    const steps: string[] = [];
    const deleteMemoriesBySession = vi.fn(async (chatId: string) => {
      steps.push(`es:${chatId}`);
    });
    const clearMessages = vi.fn((chatId: string) => {
      steps.push(`sqlite:${chatId}`);
    });

    await AppRuntime.prototype.clearMessages.call(
      {
        elasticsearchService: { deleteMemoriesBySession },
        repository: { clearMessages },
      },
      "chat-1",
    );

    expect(deleteMemoriesBySession).toHaveBeenCalledWith("chat-1");
    expect(clearMessages).toHaveBeenCalledWith("chat-1");
    expect(steps).toEqual(["es:chat-1", "sqlite:chat-1"]);
  });
});
