import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../src/backend/db/database";
import { MemoryService } from "../src/backend/services/memory/memory-service";
import type { CharacterProfile, MemoryEvent } from "../src/common/types";

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
      selfAddress: "我",
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

function createMemoryEvent(
  chatId: string,
  character: string,
  overrides: Partial<MemoryEvent> = {},
): MemoryEvent {
  return {
    id: overrides.id ?? `${character}-${Date.now()}-${Math.random()}`,
    chatId,
    sessionId: overrides.sessionId ?? "session-1",
    character,
    content: overrides.content ?? `${character} 的记忆`,
    category: overrides.category ?? "episodic",
    timestamp: overrides.timestamp ?? Date.now(),
    tags: overrides.tags ?? [],
    sourceMessageId: overrides.sourceMessageId,
    summary: overrides.summary,
    emotion: overrides.emotion,
    importance: overrides.importance,
    keyPoints: overrides.keyPoints,
    status: overrides.status,
    eventType: overrides.eventType,
    temporalState: overrides.temporalState,
    occurredAt: overrides.occurredAt,
    recordedAt: overrides.recordedAt,
    sequence: overrides.sequence,
    supersedesEventId: overrides.supersedesEventId,
    factKey: overrides.factKey,
  };
}

const createdDirectories: string[] = [];

afterEach(() => {
  createdDirectories.forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  createdDirectories.length = 0;
});

describe("MemoryService", () => {
  it("writes extracted memory into sqlite and elasticsearch", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();

    const character = createCharacter("芳乃");
    repository.upsertCharacters([character]);
    const chat = repository.createChat("single", [character.id], "芳乃 单聊");
    const userMessage = repository.appendMessage({
      chatId: chat.id,
      role: "user",
      content: "我想去神社散步",
    });
    repository.appendMessage({
      chatId: chat.id,
      role: "assistant",
      roleId: character.id,
      content: "好的，我陪你一起去。",
    });

    const indexMemory = vi.fn<(event: MemoryEvent) => Promise<void>>().mockResolvedValue();
    const service = new MemoryService(repository, {
      searchMemories: vi.fn().mockResolvedValue([]),
      indexMemory,
    } as never, {
      extractEpisodicMemory: vi.fn().mockResolvedValue({ summary: "用户想去神社散步", emotion: "开心", importance: 8, keyPoints: ["神社"], shouldRemember: true, eventType: "fact", temporalState: "active" }),
    } as never);

    const result = await service.extractAndPersist(chat.id, character, repository.listMessages(chat.id));

    expect(result?.sourceMessageId).toBeDefined();
    expect(indexMemory).not.toHaveBeenCalled();
    expect(repository.listMemoryEvents(chat.id)).toHaveLength(1);
    // 摘要按 (chatId, characterId) 隔离存储，需传入 character.id 才能取到
    expect(repository.getSummary(chat.id, character.id)).toContain(userMessage.content);
    repository.close();
  });

  it("consolidateCoreMemory only uses the specified character's memories (no cross-character pollution)", async () => {
    // 修复前：listMemoryEvents 不按 character 过滤，群聊下角色 A 的核心记忆整合
    // 会混入角色 B 的情景记忆。修复后：传入 character.id 过滤。
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-core-isolation-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "群聊");

    // 为两个角色各写入 5 条已确认情景记忆
    for (let i = 0; i < 5; i++) {
      repository.saveMemory(
        createMemoryEvent(chat.id, "丛雨", {
          summary: `丛雨的记忆 ${i}`,
          importance: 5,
        }),
      );
      repository.saveMemory(
        createMemoryEvent(chat.id, "芳乃", {
          summary: `芳乃的记忆 ${i}`,
          importance: 6,
        }),
      );
    }

    // 用 mock LLM 捕获传入的 recentMemories
    const consolidateMock = vi.fn().mockResolvedValue({
      userPreferences: ["测试偏好"],
      userTraits: ["测试特质"],
      relationshipStage: "熟悉",
      relationshipNotes: [],
      keyFacts: [],
    });

    const service = new MemoryService(repository, {
      searchMemories: vi.fn().mockResolvedValue([]),
      indexMemory: vi.fn().mockResolvedValue(undefined),
      indexCoreMemory: vi.fn().mockResolvedValue(undefined),
    } as never, {
      consolidateCoreMemory: consolidateMock,
    } as never);

    // 为丛雨整合核心记忆
    await service.consolidateCoreMemory(chat.id, createCharacter("丛雨"));

    expect(consolidateMock).toHaveBeenCalledTimes(1);
    const callArgs = consolidateMock.mock.calls[0][0];
    // 传入 LLM 的 recentMemories 应只包含丛雨的记忆
    expect(callArgs.recentMemories).toHaveLength(5);
    expect(callArgs.recentMemories.every((m: string) => m.includes("丛雨"))).toBe(true);
    expect(callArgs.characterName).toBe("丛雨");
    repository.close();
  });

  it("recall fallback score uses importance/10 without the || 0.1 fallback", async () => {
    // 修复前：score = (importance ?? 3) / 10 || 0.1
    // 当 importance=0 时，0/10=0，0 || 0.1=0.1，importance=0 的记忆获得 0.1 分
    // 修复后：score = (importance ?? 3) / 10，importance=0 时 score=0
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-recall-score-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨")]);
    const chat = repository.createChat("single", ["丛雨"], "单聊");

    // 写入不同 importance 的记忆
    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { importance: 0, summary: "不重要" }));
    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { importance: 5, summary: "中等重要" }));
    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { importance: 10, summary: "非常重要" }));

    // ES 返回空，触发降级路径
    const service = new MemoryService(repository, {
      searchMemories: vi.fn().mockResolvedValue([]),
      indexMemory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const results = await service.recall(chat.id, "测试查询", "丛雨");

    expect(results).toHaveLength(3);
    const scoreBySummary = new Map(results.map((r) => [r.text, r.score]));
    // importance=0 → score=0（修复前会是 0.1）
    expect(scoreBySummary.get("不重要")).toBe(0);
    // importance=5 → score=0.5
    expect(scoreBySummary.get("中等重要")).toBe(0.5);
    // importance=10 → score=1
    expect(scoreBySummary.get("非常重要")).toBe(1);
    repository.close();
  });

  it("recall fallback filters by characterId to prevent cross-character mixing", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-recall-filter-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "群聊");

    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { summary: "丛雨的回忆" }));
    repository.saveMemory(createMemoryEvent(chat.id, "芳乃", { summary: "芳乃的回忆" }));

    const service = new MemoryService(repository, {
      searchMemories: vi.fn().mockResolvedValue([]),
      indexMemory: vi.fn().mockResolvedValue(undefined),
    } as never);

    // 查询丛雨的记忆，不应返回芳乃的
    const results = await service.recall(chat.id, "查询", "丛雨");
    expect(results).toHaveLength(1);
    expect(results[0].character).toBe("丛雨");
    expect(results[0].text).toBe("丛雨的回忆");
    repository.close();
  });

  it("keeps pending episodic candidates out of recall until the user confirms them", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-confirm-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("芳乃"); repository.upsertCharacters([character]);
    const chat = repository.createChat("single", [character.id], "单聊");
    repository.appendMessage({ chatId: chat.id, role: "user", content: "我最喜欢抹茶" });
    repository.appendMessage({ chatId: chat.id, role: "assistant", roleId: character.id, content: "我记住了。" });
    const indexMemory = vi.fn().mockResolvedValue(undefined);
    const service = new MemoryService(repository, { searchMemories: vi.fn().mockResolvedValue([]), indexMemory } as never, {
      extractEpisodicMemory: vi.fn().mockResolvedValue({ summary: "用户喜欢抹茶", emotion: "开心", importance: 9, keyPoints: ["抹茶"], shouldRemember: true, eventType: "fact", temporalState: "active", factKey: "favorite-drink" }),
    } as never);

    const candidate = await service.extractAndPersist(chat.id, character, repository.listMessages(chat.id));
    expect(candidate?.status).toBe("pending");
    expect(await service.recall(chat.id, "喜欢什么", character.id)).toEqual([]);
    await service.confirmEvent(chat.id, candidate!.id);
    expect(indexMemory).toHaveBeenCalledWith(expect.objectContaining({ id: candidate!.id, status: "confirmed" }));
    expect((await service.recall(chat.id, "喜欢什么", character.id)).map((entry) => entry.text)).toContain("用户喜欢抹茶");
    repository.close();
  });

  it("creates a core-memory candidate only after five confirmed timeline events and applies it on confirmation", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-core-candidate-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("丛雨"); repository.upsertCharacters([character]);
    const chat = repository.createChat("single", [character.id], "单聊");
    for (let i = 1; i <= 5; i++) repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: `event-${i}`, summary: `事件 ${i}`, status: "confirmed", sequence: i, occurredAt: i, recordedAt: i }));
    const consolidateCoreMemory = vi.fn().mockResolvedValue({ userPreferences: ["抹茶"], userTraits: [], relationshipStage: "熟悉", relationshipNotes: [], keyFacts: ["已确认五条事件"] });
    const service = new MemoryService(repository, { searchMemories: vi.fn().mockResolvedValue([]), indexMemory: vi.fn() } as never, { consolidateCoreMemory } as never);

    await service.consolidateCoreMemory(chat.id, character);
    expect(consolidateCoreMemory).toHaveBeenCalledTimes(1);
    expect(repository.getCoreMemory(chat.id, character.id)).toBeUndefined();
    expect(service.getSnapshot(chat.id).coreCandidates).toHaveLength(1);
    const core = service.confirmCoreCandidate(chat.id, character.id);
    expect(core?.keyFacts).toContain("已确认五条事件");
    expect(repository.getCoreMemory(chat.id, character.id)?.relationshipStage).toBe("熟悉");
    repository.close();
  });

  it("uses confirmed SQLite memories when Elasticsearch search fails", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-es-fallback-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("芳乃"); repository.upsertCharacters([character]);
    const chat = repository.createChat("single", [character.id], "单聊");
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { summary: "本地可用记忆", status: "confirmed" }));
    const service = new MemoryService(repository, { searchMemories: vi.fn().mockRejectedValue(new Error("ES offline")), indexMemory: vi.fn() } as never);
    const results = await service.recall(chat.id, "本地", character.id);
    expect(results).toHaveLength(1); expect(results[0].text).toBe("本地可用记忆");
    repository.close();
  });

  it("does not mutate another chat's pending candidate and allocates unique timeline sequences", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-ownership-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("芳乃"); repository.upsertCharacters([character]);
    const chatA = repository.createChat("single", [character.id], "A"); const chatB = repository.createChat("single", [character.id], "B");
    repository.saveMemory(createMemoryEvent(chatB.id, character.id, { id: "b-pending", status: "pending", timestamp: 100 }));
    repository.saveMemory(createMemoryEvent(chatB.id, character.id, { id: "b-pending-2", status: "pending", timestamp: 100 }));
    const service = new MemoryService(repository, { searchMemories: vi.fn(), indexMemory: vi.fn() } as never);
    expect(await service.confirmEvent(chatA.id, "b-pending")).toBeUndefined();
    const events = repository.listTimelineEvents(chatB.id);
    expect(events.find((event) => event.id === "b-pending")?.status).toBe("pending");
    expect(new Set(events.map((event) => event.sequence)).size).toBe(2);
    repository.close();
  });

  it("supersedes the prior active fact with the same fact key on confirmation", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-conflict-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("芳乃"); repository.upsertCharacters([character]); const chat = repository.createChat("single", [character.id], "单聊");
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: "old", status: "confirmed", factKey: "favorite", temporalState: "active" }));
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: "new", status: "pending", factKey: "favorite", temporalState: "active" }));
    const deleteMemory = vi.fn().mockResolvedValue(undefined);
    const service = new MemoryService(repository, { searchMemories: vi.fn().mockResolvedValue([]), indexMemory: vi.fn(), deleteMemory } as never);
    await service.confirmEvent(chat.id, "new");
    expect(repository.listTimelineEvents(chat.id).find((event) => event.id === "old")?.temporalState).toBe("superseded");
    expect(deleteMemory).toHaveBeenCalledWith("old");
    expect((await service.recall(chat.id, "favorite", character.id)).map((entry) => entry.sourceId)).toEqual(["new"]);
    repository.close();
  });

  it("makes confirm idempotent without re-indexing and rejects an invalid dismissed-to-confirmed transition", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-state-machine-")); createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("芳乃"); repository.upsertCharacters([character]); const chat = repository.createChat("single", [character.id], "单聊");
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: "pending", status: "pending" }));
    const indexMemory = vi.fn().mockResolvedValue(undefined);
    const service = new MemoryService(repository, { searchMemories: vi.fn(), indexMemory } as never);
    expect((await service.confirmEvent(chat.id, "pending"))?.status).toBe("confirmed");
    await service.confirmEvent(chat.id, "pending");
    expect(indexMemory).toHaveBeenCalledTimes(1);
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: "dismissed", status: "pending" }));
    expect((await service.dismissEvent(chat.id, "dismissed"))?.status).toBe("dismissed");
    expect(await service.confirmEvent(chat.id, "dismissed")).toBeUndefined();
    expect(repository.getMemoryEvent(chat.id, "dismissed")?.status).toBe("dismissed");
    repository.close();
  });

  it("consolidates confirmed events in bounded five-event batches and advances by max sequence", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-batches-")); createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("丛雨"); repository.upsertCharacters([character]); const chat = repository.createChat("single", [character.id], "单聊");
    for (let i = 1; i <= 10; i++) repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: `batch-${i}`, status: "confirmed", sequence: i, occurredAt: 1000 - i, summary: `记忆 ${i}` }));
    const consolidateCoreMemory = vi.fn().mockResolvedValue({ userPreferences: [], userTraits: [], relationshipStage: "熟悉", relationshipNotes: [], keyFacts: [] });
    const service = new MemoryService(repository, { searchMemories: vi.fn(), indexMemory: vi.fn() } as never, { consolidateCoreMemory } as never);
    await service.consolidateCoreMemory(chat.id, character);
    expect(consolidateCoreMemory.mock.calls[0][0].recentMemories).toHaveLength(5);
    service.confirmCoreCandidate(chat.id, character.id);
    await service.consolidateCoreMemory(chat.id, character);
    expect(consolidateCoreMemory.mock.calls[1][0].recentMemories).toEqual(expect.arrayContaining(["记忆 6", "记忆 7", "记忆 8", "记忆 9", "记忆 10"]));
    repository.close();
  });

  it("invalidates only memories attached to edited or truncated source messages", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-invalidate-")); createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("芳乃"); repository.upsertCharacters([character]); const chat = repository.createChat("single", [character.id], "单聊");
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: "keep", sourceMessageId: "keep-message", status: "confirmed" }));
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: "remove", sourceMessageId: "edited-message", status: "confirmed" }));
    expect(repository.invalidateMemoriesBySourceMessages(chat.id, ["edited-message"])).toEqual([character.id]);
    expect(repository.getMemoryEvent(chat.id, "keep")).toBeDefined();
    expect(repository.getMemoryEvent(chat.id, "remove")).toBeUndefined();
    repository.close();
  });

  it("clears legacy memories exactly once during the timeline migration", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-memory-migration-")); createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite")); repository.init();
    const character = createCharacter("芳乃"); repository.upsertCharacters([character]); const chat = repository.createChat("single", [character.id], "单聊");
    repository.saveMemory(createMemoryEvent(chat.id, character.id, { id: "legacy", status: "confirmed" }));
    expect(repository.takeLegacyMemoryMigration()).toEqual([chat.id]);
    expect(repository.listTimelineEvents(chat.id)).toEqual([]);
    expect(repository.takeLegacyMemoryMigration()).toEqual([]);
    repository.close();
  });
});
