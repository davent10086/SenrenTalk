import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../src/backend/db/database";
import { GroupChatCoordinator } from "../src/backend/graph/group-coordinator";
import type { StructuredCompletionRequest } from "../src/backend/services/llm/deepseek-service";
import type { CharacterProfile } from "../src/common/types";

function createCharacter(id: string): CharacterProfile {
  return {
    id,
    name: id,
    displayName: id,
    isPlayable: true,
    characterType: "playable",
    summary: `${id} summary`,
    promptProfile: {
      name: id,
      role: "heroine",
      identity: `${id} identity`,
      personality: ["gentle"],
      selfAddress: id === "丛雨" ? "本座" : "我",
      tone: "温柔",
      typicalExpressions: ["你好"],
      forbiddenWords: [],
      forbiddenStyle: [],
      addressOthers: {},
      relationships: {},
      worldKnowledge: [],
      emotionalArc: {},
    },
  };
}

const createdDirectories: string[] = [];

afterEach(() => {
  createdDirectories.forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  createdDirectories.length = 0;
});

function createDeps(repository: ChatRepository, mockReturn: Record<string, unknown>) {
  return {
    repository,
    characterService: {} as never,
    elasticsearchService: {
      hybridSearch: vi.fn().mockResolvedValue([]),
    } as never,
    deepSeekService: {
      streamStructuredCompletion: vi
        .fn()
        .mockImplementation(async ({ onToken }: StructuredCompletionRequest) => {
          await onToken(mockReturn.content as string);
          return mockReturn;
        }),
    } as never,
    memoryService: {
      recall: vi.fn().mockResolvedValue([]),
      getSummary: vi.fn().mockReturnValue(undefined),
      getCoreMemory: vi.fn().mockReturnValue(null),
      extractAndPersist: vi.fn().mockResolvedValue(null),
      consolidateCoreMemory: vi.fn().mockResolvedValue(null),
    } as never,
    sseService: {
      publish: vi.fn(),
    } as never,
  };
}

describe("GroupChatCoordinator", () => {
  it("follows default round-robin order when no nextSpeaker specified", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-graph-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });

    const coordinator = new GroupChatCoordinator(
      createDeps(repository, {
        content: "我来回应。",
        speechTextJa: "返事をします。",
        raw: "{}",
      }),
      4, // maxMessages for fast test
    );

    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    const assistantMessages = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant")
      .map((m) => m.roleId);

    // 2 rounds with 2 participants = 4 messages in round-robin order
    expect(assistantMessages).toEqual(["丛雨", "芳乃", "丛雨", "芳乃"]);
    repository.close();
  });

  it("prioritizes mention target in first round", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-graph-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好 @芳乃" });

    const coordinator = new GroupChatCoordinator(
      createDeps(repository, {
        content: "收到！",
        speechTextJa: "了解！",
        raw: "{}",
      }),
      3,
    );

    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃"],
      mentionTarget: "芳乃",
      messages: repository.listMessages(chat.id),
    });

    const assistants = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant");

    // First speaker should be the mentioned target
    expect(assistants[0].roleId).toBe("芳乃");
    repository.close();
  });

  it("uses nextSpeaker for dynamic ordering", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-graph-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([
      createCharacter("丛雨"),
      createCharacter("芳乃"),
      createCharacter("茉子"),
    ]);
    const chat = repository.createChat("group", ["丛雨", "芳乃", "茉子"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });

    // First speaker (丛雨) nominates 茉子 as next; 茉子 nominates no one
    let callCount = 0;
    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ onToken }: StructuredCompletionRequest) => {
            callCount++;
            await onToken("回应");
            if (callCount === 1) {
              // 丛雨 nominates 茉子
              return { content: "回应", speechTextJa: "", raw: "{}", nextSpeaker: "茉子" };
            }
            return { content: "回应", speechTextJa: "", raw: "{}" };
          }),
      } as never,
      memoryService: {
        recall: vi.fn().mockResolvedValue([]),
        getSummary: vi.fn().mockReturnValue(undefined),
        getCoreMemory: vi.fn().mockReturnValue(null),
        extractAndPersist: vi.fn().mockResolvedValue(null),
        consolidateCoreMemory: vi.fn().mockResolvedValue(null),
      } as never,
      sseService: {
        publish: vi.fn(),
      } as never,
    };

    const coordinator = new GroupChatCoordinator(deps, 4);
    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃", "茉子"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    const assistantMessages = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant")
      .map((m) => m.roleId);

    // 丛雨 → 茉子 (nominated) → 芳乃 (fallback) → 丛雨 (new round)
    expect(assistantMessages.slice(0, 3)).toEqual(["丛雨", "茉子", "芳乃"]);
    repository.close();
  });
});