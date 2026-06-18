import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

afterEach(() => {
  createdDirectories.forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  createdDirectories.length = 0;
});

describe("ChatRepository", () => {
  it("persists characters, chats and messages in sqlite", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-db-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));

    repository.init();
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
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-db-filter-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨"), createCharacter("芳乃")]);
    const chat = repository.createChat("group", ["丛雨", "芳乃"], "群聊");

    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { content: "丛雨的记忆" }));
    repository.saveMemory(createMemoryEvent(chat.id, "芳乃", { content: "芳乃的记忆" }));
    repository.saveMemory(createMemoryEvent(chat.id, "丛雨", { content: "丛雨的第二条" }));

    // 不传 character：返回所有
    const all = repository.listMemoryEvents(chat.id);
    expect(all).toHaveLength(3);

    // 传 character="丛雨"：只返回丛雨的
    const onlyCongyu = repository.listMemoryEvents(chat.id, 20, "丛雨");
    expect(onlyCongyu).toHaveLength(2);
    expect(onlyCongyu.every((e) => e.character === "丛雨")).toBe(true);

    // 传 character="芳乃"：只返回芳乃的
    const onlyFangnai = repository.listMemoryEvents(chat.id, 20, "芳乃");
    expect(onlyFangnai).toHaveLength(1);
    expect(onlyFangnai[0].character).toBe("芳乃");

    // 传不存在的 character：返回空
    const none = repository.listMemoryEvents(chat.id, 20, "不存在");
    expect(none).toHaveLength(0);
    repository.close();
  });

  it("saveMemory persists summary/emotion/importance/keyPoints fields", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-db-fields-"));
    createdDirectories.push(tempDirectory);
    const repository = new ChatRepository(path.join(tempDirectory, "test.sqlite"));
    repository.init();
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
    const event = events[0];
    expect(event.summary).toBe("用户和丛雨讨论了天气");
    expect(event.emotion).toBe("开心");
    expect(event.importance).toBe(7);
    expect(event.keyPoints).toEqual(["用户喜欢晴天", "丛雨提议散步"]);
    repository.close();
  });

  it("init is idempotent and migrates memory_events columns on existing databases", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-db-migrate-"));
    createdDirectories.push(tempDirectory);
    const dbPath = path.join(tempDirectory, "test.sqlite");

    // 模拟旧数据库：先创建一个没有新列的 memory_events 表
    const oldDb = new (require("better-sqlite3"))(dbPath);
    oldDb.exec(`
      CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, display_name TEXT, is_playable INTEGER, character_type TEXT, summary TEXT, prompt_profile_json TEXT);
      CREATE TABLE chats (id TEXT PRIMARY KEY, mode TEXT, title TEXT, participant_ids_json TEXT, created_at INTEGER, updated_at INTEGER, mention_target TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, role_id TEXT, content TEXT, timestamp INTEGER, metadata_json TEXT);
      CREATE TABLE memory_events (id TEXT PRIMARY KEY, chat_id TEXT, session_id TEXT, character TEXT, content TEXT, category TEXT, timestamp INTEGER, tags_json TEXT, source_message_id TEXT);
      CREATE TABLE memory_summaries (id TEXT PRIMARY KEY, chat_id TEXT, summary TEXT, created_at INTEGER);
      CREATE TABLE core_memories (id TEXT PRIMARY KEY, chat_id TEXT, character TEXT, user_preferences_json TEXT, user_traits_json TEXT, relationship_stage TEXT, relationship_notes_json TEXT, key_facts_json TEXT, updated_at INTEGER);
    `);
    // 插入一条旧数据（没有 summary/emotion/importance/key_points_json）
    oldDb.prepare(
      "INSERT INTO memory_events (id, chat_id, session_id, character, content, category, timestamp, tags_json, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("old-1", "chat-1", "session-1", "丛雨", "旧记忆", "episodic", Date.now(), "[]", null);
    oldDb.close();

    // 用 ChatRepository.init() 打开旧数据库，应自动迁移
    const repository = new ChatRepository(dbPath);
    repository.init();
    repository.upsertCharacters([createCharacter("丛雨")]);

    // 旧数据应该能被读取，新字段为 undefined
    const events = repository.listMemoryEvents("chat-1");
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("旧记忆");
    expect(events[0].summary).toBeUndefined();
    expect(events[0].importance).toBeUndefined();

    // 新数据应该能正常写入和读取新字段
    repository.saveMemory(
      createMemoryEvent("chat-1", "丛雨", {
        summary: "迁移后的新记忆",
        importance: 5,
      }),
    );
    const updated = repository.listMemoryEvents("chat-1");
    expect(updated).toHaveLength(2);
    const newEvent = updated.find((e) => e.summary === "迁移后的新记忆");
    expect(newEvent?.importance).toBe(5);
    repository.close();
  });
});
