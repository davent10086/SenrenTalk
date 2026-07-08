import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../src/backend/db/database";
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
  };
}

const createdDirectories: string[] = [];

function createRepository(prefix: string): { repository: ChatRepository; tempDirectory: string } {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirectories.push(tempDirectory);
  const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
  repository.init();
  return { repository, tempDirectory };
}

afterEach(() => {
  createdDirectories.forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  createdDirectories.length = 0;
});

describe("ChatRepository", () => {
  it("persists characters, chats and messages in sqlite", () => {
    const { repository } = createRepository("rp-chat-db-");
    repository.upsertCharacters([createCharacter("丛雨")]);

    const chat = repository.createChat("single", ["丛雨"], "丛雨 单聊");
    const message = repository.appendMessage({
      chatId: chat.id,
      role: "user",
      content: "你好",
    });

    repository.saveSummary(chat.id, "摘要内容");

    expect(repository.listCharacters()).toHaveLength(1);
    expect(repository.listChats()).toHaveLength(1);
    expect(repository.listMessages(chat.id)[0]?.id).toBe(message.id);
    expect(repository.getSummary(chat.id)).toBe("摘要内容");
    repository.close();
  });

  it("listMemoryEvents filters by character when provided", () => {
    const { repository } = createRepository("rp-chat-db-filter-");
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "群聊");

    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { content: "丛雨的记忆" }));
    repository.saveMemory(createMemoryEvent(chat.id, "芳乃", { content: "芳乃的记忆" }));
    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { content: "丛雨的第二条" }));

    const all = repository.listMemoryEvents(chat.id);
    expect(all).toHaveLength(3);

    const onlyCongyu = repository.listMemoryEvents(chat.id, 20, "丛雨");
    expect(onlyCongyu).toHaveLength(2);
    expect(onlyCongyu.every((event) => event.character === "丛雨")).toBe(true);

    const onlyFangnai = repository.listMemoryEvents(chat.id, 20, "芳乃");
    expect(onlyFangnai).toHaveLength(1);
    expect(onlyFangnai[0].character).toBe("芳乃");

    const none = repository.listMemoryEvents(chat.id, 20, "不存在");
    expect(none).toHaveLength(0);
    repository.close();
  });

  it("saveMemory persists summary/emotion/importance/keyPoints fields", () => {
    const { repository } = createRepository("rp-chat-db-fields-");
    repository.upsertCharacters([createCharacter("丛雨")]);
    const chat = repository.createChat("single", ["丛雨"], "单聊");

    repository.saveMemory(
      createMemoryEvent(chat.id, "丛雨", {
        summary: "用户和丛雨讨论了天气",
        emotion: "开心",
        importance: 7,
        keyPoints: ["用户喜欢晴天", "丛雨提议散步"],
      }),
    );

    const events = repository.listMemoryEvents(chat.id);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("用户和丛雨讨论了天气");
    expect(events[0].emotion).toBe("开心");
    expect(events[0].importance).toBe(7);
    expect(events[0].keyPoints).toEqual(["用户喜欢晴天", "丛雨提议散步"]);
    repository.close();
  });

  it("init is idempotent and migrates legacy memory_events columns", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-db-migrate-"));
    createdDirectories.push(tempDirectory);
    const dbPath = path.join(tempDirectory, "test.sqlite");

    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, display_name TEXT, is_playable INTEGER, character_type TEXT, summary TEXT, prompt_profile_json TEXT);
      CREATE TABLE chats (id TEXT PRIMARY KEY, mode TEXT, title TEXT, participants_json TEXT, mention_target TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, role_id TEXT, content TEXT, timestamp INTEGER, metadata_json TEXT);
      CREATE TABLE memory_events (id TEXT PRIMARY KEY, chat_id TEXT, session_id TEXT, character TEXT, content TEXT, category TEXT, timestamp INTEGER, tags_json TEXT, source_message_id TEXT);
      CREATE TABLE memory_summaries (id TEXT PRIMARY KEY, chat_id TEXT, character_id TEXT, summary TEXT, created_at INTEGER);
      CREATE TABLE core_memories (id TEXT PRIMARY KEY, chat_id TEXT, character_id TEXT, user_preferences_json TEXT, user_traits_json TEXT, relationship_stage TEXT, relationship_notes_json TEXT, key_facts_json TEXT, last_updated INTEGER);
    `);
    oldDb.prepare(
      "INSERT INTO memory_events (id, chat_id, session_id, character, content, category, timestamp, tags_json, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("old-1", "chat-1", "session-1", "丛雨", "旧记忆", "episodic", Date.now(), "[]", null);
    oldDb.close();

    const repository = new ChatRepository(dbPath);
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨")]);

    const events = repository.listMemoryEvents("chat-1");
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("旧记忆");
    expect(events[0].summary).toBeUndefined();
    expect(events[0].importance).toBeUndefined();

    repository.saveMemory(
      createMemoryEvent("chat-1", "丛雨", {
        summary: "迁移后的新记忆",
        importance: 5,
      }),
    );
    const updated = repository.listMemoryEvents("chat-1");
    expect(updated).toHaveLength(2);
    expect(updated.find((event) => event.summary === "迁移后的新记忆")?.importance).toBe(5);
    repository.close();
  });

  it("creates group chats with default room config and room state", () => {
    const { repository } = createRepository("rp-chat-db-room-defaults-");
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);

    const chat = repository.createChat("group", ["丛雨", "芳乃"], "群聊");

    expect(chat.mentionTarget).toBeNull();
    expect(chat.roomConfig?.mode).toBe("single_round");
    expect(chat.roomConfig?.maxRounds).toBe(1);
    expect(chat.roomConfig?.maxMessages).toBe(2);
    expect(chat.roomConfig?.speakerPolicy).toBe("mentioned_first");
    expect(chat.roomConfig?.silencePolicy).toBe("must_reply_if_mentioned");
    expect(chat.roomState).toMatchObject({
      currentRound: 0,
      currentTurn: 0,
      plannedSpeakers: [],
      lastSpeakers: [],
      skippedRoles: [],
      lastTargetRoleId: null,
    });
    expect(chat.roomState?.lastFinishedReason).toBeUndefined();

    const reloaded = repository.getChat(chat.id);
    expect(reloaded?.roomConfig).toEqual(chat.roomConfig);
    expect(reloaded?.roomState).toEqual(chat.roomState);
    repository.close();
  });

  it("persists room config and room state updates for group chats", () => {
    const { repository } = createRepository("rp-chat-db-room-updates-");
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);

    const chat = repository.createChat("group", ["丛雨", "芳乃"], "群聊");

    const configUpdated = repository.updateChatRoomConfig(chat.id, {
      mode: "free_chat",
      targetRoleId: "芳乃",
      topic: "夏日祭",
      scene: "神社门口",
      maxRounds: 3,
    });
    expect(configUpdated.mentionTarget).toBe("芳乃");
    expect(configUpdated.roomConfig).toMatchObject({
      mode: "free_chat",
      targetRoleId: "芳乃",
      topic: "夏日祭",
      scene: "神社门口",
      maxRounds: 3,
    });
    expect(configUpdated.roomState?.lastTargetRoleId).toBe("芳乃");

    const stateUpdated = repository.updateChatRoomState(chat.id, {
      currentRound: 2,
      currentTurn: 1,
      plannedSpeakers: ["芳乃"],
      lastSpeakers: ["丛雨"],
      skippedRoles: [{ roleId: "丛雨", reason: "no_new_value" }],
      lastFinishedReason: "本轮已结束",
      consensus: ["大家都认同先出门"],
      unresolved: ["谁来带路"],
      mood: "轻松",
    });
    expect(stateUpdated.roomState).toMatchObject({
      currentRound: 2,
      currentTurn: 1,
      plannedSpeakers: ["芳乃"],
      lastSpeakers: ["丛雨"],
      skippedRoles: [{ roleId: "丛雨", reason: "no_new_value" }],
      lastFinishedReason: "本轮已结束",
      consensus: ["大家都认同先出门"],
      unresolved: ["谁来带路"],
      mood: "轻松",
      lastTargetRoleId: "芳乃",
    });

    repository.appendMessage({
      chatId: chat.id,
      role: "assistant",
      roleId: "丛雨",
      content: "那就出发吧。",
    });

    expect(repository.getChat(chat.id)?.mentionTarget).toBe("芳乃");
    repository.close();
  });

  it("normalizes stale single_round config when switching back from free_chat", () => {
    const { repository } = createRepository("rp-chat-db-room-single-round-normalize-");
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃"), createCharacter("茉子")]);

    const chat = repository.createChat("group", ["丛雨", "芳乃", "茉子"], "群聊");

    repository.updateChatRoomConfig(chat.id, {
      mode: "free_chat",
      maxRounds: 3,
      maxMessages: 9,
    });

    const normalized = repository.updateChatRoomConfig(chat.id, {
      mode: "single_round",
      maxRounds: 3,
      maxMessages: 9,
    });

    expect(normalized.roomConfig).toMatchObject({
      mode: "single_round",
      maxRounds: 1,
      maxMessages: 3,
    });
    repository.close();
  });

  it("migrates legacy chats without room columns and backfills default room data", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-db-room-migrate-"));
    createdDirectories.push(tempDirectory);
    const dbPath = path.join(tempDirectory, "test.sqlite");

    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, display_name TEXT, is_playable INTEGER, character_type TEXT, summary TEXT, prompt_profile_json TEXT);
      CREATE TABLE chats (id TEXT PRIMARY KEY, mode TEXT, title TEXT, participants_json TEXT, mention_target TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, role_id TEXT, content TEXT, timestamp INTEGER, metadata_json TEXT);
      CREATE TABLE memory_events (id TEXT PRIMARY KEY, chat_id TEXT, session_id TEXT, character TEXT, content TEXT, category TEXT, timestamp INTEGER, tags_json TEXT, source_message_id TEXT);
      CREATE TABLE memory_summaries (id TEXT PRIMARY KEY, chat_id TEXT, character_id TEXT, summary TEXT, created_at INTEGER);
      CREATE TABLE core_memories (id TEXT PRIMARY KEY, chat_id TEXT, character_id TEXT, user_preferences_json TEXT, user_traits_json TEXT, relationship_stage TEXT, relationship_notes_json TEXT, key_facts_json TEXT, last_updated INTEGER);
    `);
    oldDb.prepare(
      "INSERT INTO chats (id, mode, title, participants_json, mention_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("group-1", "group", "旧群聊", JSON.stringify(["丛雨", "芳乃"]), "芳乃", Date.now(), Date.now());
    oldDb.close();

    const repository = new ChatRepository(dbPath);
    repository.init();

    const chat = repository.getChat("group-1");
    expect(chat?.mentionTarget).toBe("芳乃");
    expect(chat?.roomConfig).toMatchObject({
      mode: "single_round",
      targetRoleId: "芳乃",
      maxRounds: 1,
      maxMessages: 2,
    });
    expect(chat?.roomState).toMatchObject({
      currentRound: 0,
      currentTurn: 0,
      lastTargetRoleId: "芳乃",
    });

    const migratedDb = new Database(dbPath, { readonly: true });
    const columns = migratedDb.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("room_config_json");
    expect(columns.map((column) => column.name)).toContain("room_state_json");
    migratedDb.close();
    repository.close();
  });
});
