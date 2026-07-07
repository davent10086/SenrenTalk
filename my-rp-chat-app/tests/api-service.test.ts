import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "../src/server/api-service";

const createdDirectories: string[] = [];
const createdApis: ApiService[] = [];

function createTempWorkspace(): string {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-api-"));
  createdDirectories.push(tempDirectory);
  return tempDirectory;
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  while (createdApis.length > 0) {
    const api = createdApis.pop();
    await api?.dispose();
  }
  for (const directory of createdDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  createdDirectories.length = 0;
});

describe("ApiService.startDialogueIndexJob", () => {
  it("stores index progress and final duration on the background job", async () => {
    const appRoot = createTempWorkspace();
    const userDataPath = createTempWorkspace();
    const api = new ApiService(appRoot, userDataPath);
    createdApis.push(api);

    Object.assign(api.runtime, {
      rebuildDialogueIndex: vi.fn().mockImplementation(async (onProgress?: (progress: {
        current: number;
        total?: number;
        stage?: string;
      }) => void) => {
        onProgress?.({ current: 2, total: 4, stage: "embedding" });
        await new Promise((resolve) => setTimeout(resolve, 30));
        onProgress?.({ current: 4, total: 4, stage: "bulk_index" });
        return { indexedCount: 4 };
      }),
    });

    const initialJob = await api.startDialogueIndexJob();
    expect(initialJob?.status).toBe("running");

    await waitFor(() => api.listJobs()[0]?.status === "completed");

    const completedJob = api.listJobs()[0];
    expect(completedJob.progress).toEqual({
      current: 4,
      total: 4,
      stage: "bulk_index",
      percent: 100,
    });
    expect(completedJob.result).toEqual({ indexedCount: 4 });
    expect(completedJob.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("ApiService.cancelJob", () => {
  it("aborts a running chat job and marks it as cancelled", async () => {
    const appRoot = createTempWorkspace();
    const userDataPath = createTempWorkspace();
    const api = new ApiService(appRoot, userDataPath);
    createdApis.push(api);

    let receivedSignal: AbortSignal | undefined;
    Object.assign(api.runtime, {
      sendMessage: vi.fn().mockImplementation(async (_request, hooks?: {
        jobId?: string;
        signal?: AbortSignal;
        onJobRunning?: (jobId: string, streamId: string) => void;
      }) => {
        receivedSignal = hooks?.signal;
        if (hooks?.jobId) {
          hooks.onJobRunning?.(hooks.jobId, "stream-cancel");
        }
        return {
          jobId: hooks?.jobId ?? "job-1",
          streamId: "stream-cancel",
          streamUrl: "http://127.0.0.1/streams/stream-cancel",
        };
      }),
    });

    const sendResult = await api.sendMessage({
      chatId: "chat-1",
      content: "你好",
      mode: "single",
      participants: ["芳乃"],
    });
    expect(sendResult.jobId).toBeTruthy();

    const cancelledJob = await api.cancelJob(sendResult.jobId);

    expect(receivedSignal?.aborted).toBe(true);
    expect(cancelledJob.status).toBe("cancelled");
    expect(cancelledJob.error).toBe("消息生成已中断");
  });
});

describe("ApiService room APIs", () => {
  it("passes roomConfig through createChat for group chats", () => {
    const appRoot = createTempWorkspace();
    const userDataPath = createTempWorkspace();
    const api = new ApiService(appRoot, userDataPath);
    createdApis.push(api);

    const expectedChat = {
      id: "chat-room-1",
      title: "群聊",
      mode: "group",
      participants: ["芳乃", "茉子"],
      mentionTarget: "芳乃",
      roomConfig: {
        mode: "free_chat",
        targetRoleId: "芳乃",
        maxRounds: 3,
      },
      roomState: undefined,
      createdAt: 1,
      updatedAt: 1,
    };

    const createChat = vi.fn().mockReturnValue(expectedChat);
    Object.assign(api.runtime, { createChat });

    const result = api.createChat("group", ["芳乃", "茉子"], "群聊", {
      mode: "free_chat",
      targetRoleId: "芳乃",
      maxRounds: 3,
    });

    expect(createChat).toHaveBeenCalledWith("group", ["芳乃", "茉子"], "群聊", {
      mode: "free_chat",
      targetRoleId: "芳乃",
      maxRounds: 3,
    });
    expect(result).toBe(expectedChat);
  });

  it("delegates room config and room state updates to runtime", () => {
    const appRoot = createTempWorkspace();
    const userDataPath = createTempWorkspace();
    const api = new ApiService(appRoot, userDataPath);
    createdApis.push(api);

    const expectedChat = {
      id: "chat-room-2",
      title: "群聊",
      mode: "group",
      participants: ["芳乃", "茉子"],
      mentionTarget: "茉子",
      roomConfig: {
        mode: "single_round",
        targetRoleId: "茉子",
      },
      roomState: {
        currentRound: 1,
        plannedSpeakers: ["茉子"],
        lastFinishedReason: "仅定向角色回复",
      },
      createdAt: 1,
      updatedAt: 2,
    };

    const updateGroupChatRoom = vi.fn().mockReturnValue(expectedChat);
    Object.assign(api.runtime, { updateGroupChatRoom });

    const result = api.updateGroupChatRoom("chat-room-2", {
      roomConfig: {
        targetRoleId: "茉子",
      },
      roomState: {
        currentRound: 1,
        plannedSpeakers: ["茉子"],
        lastFinishedReason: "仅定向角色回复",
      },
    });

    expect(updateGroupChatRoom).toHaveBeenCalledWith("chat-room-2", {
      roomConfig: {
        targetRoleId: "茉子",
      },
      roomState: {
        currentRound: 1,
        plannedSpeakers: ["茉子"],
        lastFinishedReason: "仅定向角色回复",
      },
    });
    expect(result).toBe(expectedChat);
  });
});
