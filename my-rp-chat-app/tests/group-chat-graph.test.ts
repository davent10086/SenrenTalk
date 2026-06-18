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

/** 从系统提示词中提取角色自称，用于生成通过验证的回复内容。 */
function extractSelfAddress(systemPrompt: string): string {
  const match = systemPrompt.match(/必须自称：(.+)/);
  return match ? match[1].trim() : "我";
}

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories) {
    // Windows 上 better-sqlite3 关闭后文件句柄可能仍被短暂锁定，需要重试
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
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
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            callCount++;
            // 提取角色自称并包含在回复中，确保通过 validate_response 节点
            const selfAddress = extractSelfAddress(systemPrompt);
            const content = `${selfAddress}回应`;
            await onToken(content);
            if (callCount === 1) {
              // 丛雨 nominates 茉子
              return { content, speechTextJa: "", raw: "{}", nextSpeaker: "茉子" };
            }
            return { content, speechTextJa: "", raw: "{}" };
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

  it("allows agent to voluntarily skip via skip:true without saving a message", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-skip-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });

    // 丛雨 始终跳过；芳乃 正常发言
    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            const selfAddress = extractSelfAddress(systemPrompt);
            // 丛雨 自愿跳过（自称"本座"）
            if (selfAddress === "本座") {
              return { content: "", speechTextJa: "", raw: "{}", skip: true };
            }
            // 芳乃 正常发言
            const content = `${selfAddress}回应`;
            await onToken(content);
            return { content, speechTextJa: "", raw: "{}" };
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
      participants: ["丛雨", "芳乃"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    const assistantMessages = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant")
      .map((m) => m.roleId);

    // 丛雨 始终跳过不保存消息；只有 芳乃 的消息被保存
    expect(assistantMessages.every((id) => id === "芳乃")).toBe(true);
    expect(assistantMessages).not.toContain("丛雨");
    expect(assistantMessages.length).toBeGreaterThan(0);
    repository.close();
  });

  it("exits cleanly when all agents skip every turn without errors or saved messages", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-all-skip-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });

    // 所有角色始终返回 skip: true
    const publishMock = vi.fn();
    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async () => {
            // 所有角色都自愿跳过，不调用 onToken
            return { content: "", speechTextJa: "", raw: "{}", skip: true };
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
        publish: publishMock,
      } as never,
    };

    const coordinator = new GroupChatCoordinator(deps, 4);

    // 验证 runSession 不抛异常、不挂起（vitest 默认 5s 超时会捕获挂起）
    await expect(
      coordinator.runSession({
        chatId: chat.id,
        streamId: "stream-test",
        participants: ["丛雨", "芳乃"],
        mentionTarget: null,
        messages: repository.listMessages(chat.id),
      }),
    ).resolves.toBeUndefined();

    // 没有任何 assistant 消息被保存
    const assistantMessages = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(0);

    // SSE 应发布"选择保持沉默"状态事件（每个角色每轮各一次）
    const skipStatusEvents = publishMock.mock.calls.filter(
      ([event]) => event.type === "status" && event.message === "选择保持沉默",
    );
    expect(skipStatusEvents.length).toBeGreaterThanOrEqual(2);

    // SSE 应发布空 message_done 事件清理前端草稿（每个角色每轮各一次）
    const messageDoneEvents = publishMock.mock.calls.filter(
      ([event]) => event.type === "message_done" && event.content === "",
    );
    expect(messageDoneEvents.length).toBeGreaterThanOrEqual(2);

    // 不应有 error 事件
    const errorEvents = publishMock.mock.calls.filter(([event]) => event.type === "error");
    expect(errorEvents).toHaveLength(0);

    repository.close();
  });

  it("does not double-increment turnCount for chained nextSpeaker (all 3 roles speak in round 1)", async () => {
    // 修复前：链式发言会双重递增 turnCount，导致 3 角色 maxRounds=3 时
    // 第 2 个角色发言后 turnCount 就达到上限，第 3 个角色无法发言。
    // 修复后：turnCount 只在一轮所有角色发言完毕后递增，3 角色都能发言。
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-turncount-"));
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

    // 每个角色都指定下一个发言者，形成链式：丛雨→芳乃→茉子
    let callCount = 0;
    const chain: Array<string | undefined> = ["芳乃", "茉子", undefined];
    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            const idx = callCount++;
            // 提取角色自称并包含在回复中，确保通过 validate_response 节点
            const selfAddress = extractSelfAddress(systemPrompt);
            const content = `${selfAddress}回应`;
            await onToken(content);
            return {
              content,
              speechTextJa: "",
              raw: "{}",
              nextSpeaker: chain[idx],
            };
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

    // maxMessages=3, maxRounds=1：一轮内 3 个角色都应能发言
    const coordinator = new GroupChatCoordinator(deps, 3, 1, 2);
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

    // 3 个角色都应在第 1 轮发言：丛雨→芳乃→茉子
    expect(assistantMessages).toEqual(["丛雨", "芳乃", "茉子"]);
    repository.close();
  });

  it("exits when idleStreak threshold reached (no nextSpeaker for N rounds)", async () => {
    // 修复后：idleStreak 跟踪"本轮是否有 agent 指定 nextSpeaker"，
    // 连续 idleStreakThreshold 轮无人指定则退出。
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-idle-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });

    // 所有角色都不指定 nextSpeaker
    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            const selfAddress = extractSelfAddress(systemPrompt);
            const content = `${selfAddress}回应`;
            await onToken(content);
            return { content, speechTextJa: "", raw: "{}" };
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

    // maxMessages=20 (足够大), maxRounds=10 (足够大), idleStreakThreshold=2
    // 2 角色 × 2 轮 = 4 条消息后，连续 2 轮无 nextSpeaker，应退出
    const coordinator = new GroupChatCoordinator(deps, 20, 10, 2);
    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    const assistantMessages = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant");

    // 连续 2 轮无 nextSpeaker 后退出：2 角色 × 2 轮 = 4 条消息
    expect(assistantMessages.length).toBe(4);
    // 等待 fire-and-forget 的 processMemories 完成，避免关闭数据库时文件锁定
    await new Promise((resolve) => setTimeout(resolve, 100));
    repository.close();
  });

  it("processMemories runs in parallel for all participants", async () => {
    // 验证修复后 processMemories 并行处理：所有角色的记忆处理应同时开始
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-parallel-"));
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

    // 用时间戳记录 extractAndPersist 的开始时间，验证并行性
    const startTimes: Array<{ role: string; time: number }> = [];
    const delays: Record<string, number> = { 丛雨: 100, 芳乃: 100, 茉子: 100 };

    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            const selfAddress = extractSelfAddress(systemPrompt);
            const content = `${selfAddress}回应`;
            await onToken(content);
            return { content, speechTextJa: "", raw: "{}" };
          }),
      } as never,
      memoryService: {
        recall: vi.fn().mockResolvedValue([]),
        getSummary: vi.fn().mockReturnValue(undefined),
        getCoreMemory: vi.fn().mockReturnValue(null),
        extractAndPersist: vi.fn().mockImplementation(async (chatId: string, character: { id: string }) => {
          const t = Date.now();
          startTimes.push({ role: character.id, time: t });
          // 模拟处理延迟
          await new Promise((resolve) => setTimeout(resolve, delays[character.id] ?? 50));
          return null;
        }),
        consolidateCoreMemory: vi.fn().mockResolvedValue(null),
      } as never,
      sseService: {
        publish: vi.fn(),
      } as never,
    };

    // maxMessages=3 让对话快速结束，然后 processMemories 被触发
    const coordinator = new GroupChatCoordinator(deps, 3, 1, 2);
    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃", "茉子"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    // 等待 fire-and-forget 的 processMemories 完成
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 3 个角色的 extractAndPersist 都应被调用
    expect(startTimes.length).toBe(3);

    // 验证并行：所有开始时间应非常接近（差值 < 50ms），
    // 如果是串行则差值会 >= 100ms（每个角色的延迟）
    const times = startTimes.map((s) => s.time).sort((a, b) => a - b);
    const maxDiff = times[times.length - 1] - times[0];
    expect(maxDiff).toBeLessThan(50);
    repository.close();
  });

  it("skips failed role and continues with remaining roles", async () => {
    // 验证：当某个角色的 agent 抛出异常时，协调器应跳过该角色并继续处理其他角色
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-fail-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });

    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            const selfAddress = extractSelfAddress(systemPrompt);
            // 丛雨 抛出异常
            if (selfAddress === "本座") {
              throw new Error("LLM 调用失败");
            }
            // 芳乃 正常发言
            const content = `${selfAddress}回应`;
            await onToken(content);
            return { content, speechTextJa: "", raw: "{}" };
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

    // maxRounds=1：一轮内 丛雨 失败、芳乃 正常发言
    const coordinator = new GroupChatCoordinator(deps, 4, 1, 2);
    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    const assistantMessages = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant");

    // 芳乃 应正常发言
    expect(assistantMessages.some((m) => m.roleId === "芳乃")).toBe(true);
    // 丛雨 不应有保存的消息
    expect(assistantMessages.every((m) => m.roleId !== "丛雨")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    repository.close();
  });

  it("publishes error event with roleId when role fails", async () => {
    // 验证：角色失败时通过 SSE 发布 error 事件，携带 roleId 供前端定位失败角色
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-err-"));
    createdDirectories.push(tempDirectory);

    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "测试群聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });

    const publishMock = vi.fn();
    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            const selfAddress = extractSelfAddress(systemPrompt);
            if (selfAddress === "本座") {
              throw new Error("LLM 调用失败");
            }
            const content = `${selfAddress}回应`;
            await onToken(content);
            return { content, speechTextJa: "", raw: "{}" };
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
        publish: publishMock,
      } as never,
    };

    const coordinator = new GroupChatCoordinator(deps, 4, 1, 2);
    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    // 应发布 error 事件，携带 roleId=丛雨 和失败消息
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        streamId: "stream-test",
        roleId: "丛雨",
        message: expect.stringContaining("丛雨"),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    repository.close();
  });

  it("does not save message for failed role", async () => {
    // 验证：角色失败后不保存任何 assistant 消息，避免数据库中出现空消息
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-nosave-"));
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

    const deps = {
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: vi.fn().mockResolvedValue([]),
      } as never,
      deepSeekService: {
        streamStructuredCompletion: vi
          .fn()
          .mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
            const selfAddress = extractSelfAddress(systemPrompt);
            // 丛雨 抛出异常
            if (selfAddress === "本座") {
              throw new Error("LLM 调用失败");
            }
            // 芳乃 和 茉子 正常发言
            const content = `${selfAddress}回应`;
            await onToken(content);
            return { content, speechTextJa: "", raw: "{}" };
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

    // maxRounds=1：3 角色各发言一次，丛雨 失败
    const coordinator = new GroupChatCoordinator(deps, 6, 1, 2);
    await coordinator.runSession({
      chatId: chat.id,
      streamId: "stream-test",
      participants: ["丛雨", "芳乃", "茉子"],
      mentionTarget: null,
      messages: repository.listMessages(chat.id),
    });

    const assistantMessages = repository
      .listMessages(chat.id)
      .filter((m) => m.role === "assistant");

    // 丛雨 不应有任何保存的消息
    expect(assistantMessages.every((m) => m.roleId !== "丛雨")).toBe(true);
    // 芳乃 和 茉子 应各有消息
    expect(assistantMessages.some((m) => m.roleId === "芳乃")).toBe(true);
    expect(assistantMessages.some((m) => m.roleId === "茉子")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    repository.close();
  });
});