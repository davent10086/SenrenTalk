import { describe, expect, it } from "vitest";
import { JobRegistry } from "../src/backend/job-registry";

describe("JobRegistry", () => {
  it("tracks chat job lifecycle and running lookup", () => {
    const registry = new JobRegistry();
    const job = registry.createJob({
      type: "chat",
      chatId: "chat-1",
    });

    expect(job.status).toBe("pending");
    expect(registry.findRunningChatJob("chat-1")).toBeUndefined();

    registry.updateJob(job.id, "running", {
      streamId: "stream-1",
    });

    expect(registry.findRunningChatJob("chat-1")?.id).toBe(job.id);

    registry.updateJob(job.id, "completed", {
      result: {
        messageCount: 2,
      },
    });

    expect(registry.findRunningChatJob("chat-1")).toBeUndefined();
    expect(registry.getJob(job.id).result).toEqual({ messageCount: 2 });
  });

  it("sorts jobs by newest first", () => {
    const registry = new JobRegistry();
    const older = registry.createJob({ type: "index_dialogues" });
    const newer = registry.createJob({ type: "chat", chatId: "chat-2" });

    expect(registry.listJobs().map((job) => job.id)).toEqual([newer.id, older.id]);
  });
});
