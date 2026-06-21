import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  CharacterProfile,
  ChatMessage,
  ChatMessageMetadata,
  ChatMode,
  ChatRecord,
  MemoryEvent,
  MessageAudio,
} from "../../common/types";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface CharacterRow {
  id: string;
  name: string;
  display_name: string;
  is_playable: number;
  character_type: string;
  summary: string;
  prompt_profile_json: string;
}

interface ChatRow {
  id: string;
  title: string;
  mode: ChatMode;
  participants_json: string;
  mention_target: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  chat_id: string;
  role: ChatMessage["role"];
  role_id: string | null;
  content: string;
  timestamp: number;
  metadata_json: string | null;
}

interface CoreMemoryRow {
  id: string;
  chat_id: string;
  character_id: string;
  user_preferences_json: string;
  user_traits_json: string;
  relationship_stage: string;
  relationship_notes_json: string;
  key_facts_json: string;
  last_updated: number;
}

interface MemoryRow {
  id: string;
  chat_id: string;
  session_id: string;
  character: string;
  content: string;
  category: string;
  timestamp: number;
  tags_json: string;
  source_message_id: string | null;
  summary: string | null;
  emotion: string | null;
  importance: number | null;
  key_points_json: string | null;
}

/**
 * 聊天数据仓库，封装所有与 SQLite 数据库的交互操作。
 * 管理角色信息、聊天记录、消息、记忆事件和核心记忆等数据。
 */
export class ChatRepository {
  /**
   * 会话级摘要的 character_id 占位符。
   *
   * 当调用方未提供 characterId 时使用此值，保持与旧版本（会话级摘要）的兼容。
   * 群聊场景下应始终传入具体角色 ID，以实现按角色隔离的摘要记忆。
   */
  static readonly CHAT_LEVEL_SUMMARY_KEY = "__chat__";

  private readonly db: Database.Database;

  /**
   * 创建 ChatRepository 实例并打开指定路径的 SQLite 数据库。
   * @param databasePath - SQLite 数据库文件的完整路径，会自动创建父目录
   */
  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  /**
   * 初始化数据库表结构。创建 characters、chats、messages、memory_events、
   * core_memories、memory_summaries 等表（如果不存在则创建）。
   */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_playable INTEGER NOT NULL,
        character_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        prompt_profile_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        mention_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        role_id TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(chat_id) REFERENCES chats(id)
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        character TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        source_message_id TEXT,
        FOREIGN KEY(chat_id) REFERENCES chats(id)
      );

      CREATE TABLE IF NOT EXISTS core_memories (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        user_preferences_json TEXT NOT NULL DEFAULT '[]',
        user_traits_json TEXT NOT NULL DEFAULT '[]',
        relationship_stage TEXT NOT NULL DEFAULT '',
        relationship_notes_json TEXT NOT NULL DEFAULT '[]',
        key_facts_json TEXT NOT NULL DEFAULT '[]',
        last_updated INTEGER NOT NULL,
        UNIQUE(chat_id, character_id),
        FOREIGN KEY(chat_id) REFERENCES chats(id)
      );

      CREATE TABLE IF NOT EXISTS memory_summaries (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        character_id TEXT NOT NULL DEFAULT '__chat__',
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(chat_id, character_id)
      );

      -- Indexes for frequently queried columns
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_memory_events_chat_id_session ON memory_events(chat_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_memory_events_character ON memory_events(chat_id, character);
      CREATE INDEX IF NOT EXISTS idx_core_memories_chat_id ON core_memories(chat_id);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_chat_id ON memory_summaries(chat_id);
    `);

    // 迁移：为 memory_events 添加记忆提炼字段（SQLite 的 ADD COLUMN 对已有数据兼容，旧数据为 NULL）
    this.ensureMemoryEventColumns();
    // 迁移：为 memory_summaries 添加 character_id 列并将 UNIQUE 约束改为 (chat_id, character_id)
    this.migrateMemorySummariesForCharacterIsolation();
  }

  /**
   * 确保 memory_events 表包含记忆提炼所需的字段。
   * 使用 ALTER TABLE ADD COLUMN 进行增量迁移，已有数据的新列值为 NULL。
   */
  private ensureMemoryEventColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>;
    const existing = new Set(columns.map((c) => c.name));
    const required: Array<{ name: string; def: string }> = [
      { name: "summary", def: "TEXT" },
      { name: "emotion", def: "TEXT" },
      { name: "importance", def: "INTEGER" },
      { name: "key_points_json", def: "TEXT" },
    ];
    for (const col of required) {
      if (!existing.has(col.name)) {
        this.db.exec(`ALTER TABLE memory_events ADD COLUMN ${col.name} ${col.def}`);
      }
    }
  }

  /**
   * 迁移 memory_summaries 表以支持按 (chat_id, character_id) 隔离摘要。
   *
   * 旧 schema：UNIQUE(chat_id)，会话级摘要，群聊下多角色互相覆盖。
   * 新 schema：UNIQUE(chat_id, character_id)，每个角色独立摘要。
   *
   * SQLite 不支持直接修改 UNIQUE 约束，需重建表：
   * 1. 重命名旧表
   * 2. 创建新表（新 schema）
   * 3. 复制旧数据，character_id 填充为 CHAT_LEVEL_SUMMARY_KEY
   * 4. 删除旧表
   *
   * 已迁移的表（含 character_id 列）直接跳过。
   */
  private migrateMemorySummariesForCharacterIsolation(): void {
    const columns = this.db.prepare("PRAGMA table_info(memory_summaries)").all() as Array<{ name: string }>;
    const existing = new Set(columns.map((c) => c.name));
    if (existing.has("character_id")) {
      return;
    }

    this.db.exec(`
      ALTER TABLE memory_summaries RENAME TO memory_summaries_old;
      CREATE TABLE memory_summaries (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        character_id TEXT NOT NULL DEFAULT '${ChatRepository.CHAT_LEVEL_SUMMARY_KEY}',
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(chat_id, character_id)
      );
      INSERT INTO memory_summaries (id, chat_id, character_id, summary, created_at)
        SELECT id, chat_id, '${ChatRepository.CHAT_LEVEL_SUMMARY_KEY}', summary, created_at
        FROM memory_summaries_old;
      DROP TABLE memory_summaries_old;
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_chat_id ON memory_summaries(chat_id);
    `);
  }

  /**
   * 批量插入或更新角色信息。如果角色 ID 已存在则更新，否则插入新记录。
   * @param characters - 角色信息数组
   */
  upsertCharacters(characters: CharacterProfile[]): void {
    const statement = this.db.prepare(`
      INSERT INTO characters (id, name, display_name, is_playable, character_type, summary, prompt_profile_json)
      VALUES (@id, @name, @display_name, @is_playable, @character_type, @summary, @prompt_profile_json)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        display_name = excluded.display_name,
        is_playable = excluded.is_playable,
        character_type = excluded.character_type,
        summary = excluded.summary,
        prompt_profile_json = excluded.prompt_profile_json
    `);

    const transaction = this.db.transaction((rows: CharacterProfile[]) => {
      rows.forEach((character) => {
        statement.run({
          id: character.id,
          name: character.name,
          display_name: character.displayName,
          is_playable: character.isPlayable ? 1 : 0,
          character_type: character.characterType,
          summary: character.summary,
          prompt_profile_json: JSON.stringify(character.promptProfile),
        });
      });
    });

    transaction(characters);
  }

  /**
   * 查询所有角色，按是否可扮演降序、名称升序排列。
   * @returns 角色信息数组
   */
  listCharacters(): CharacterProfile[] {
    const rows = this.db.prepare("SELECT * FROM characters ORDER BY is_playable DESC, name ASC").all() as CharacterRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      isPlayable: row.is_playable === 1,
      characterType: row.character_type,
      summary: row.summary,
      promptProfile: parseJson(row.prompt_profile_json, {
        name: row.name,
        role: "",
        identity: "",
        personality: [],
        selfAddress: "我",
        tone: "自然",
        typicalExpressions: [],
        forbiddenWords: [],
        forbiddenStyle: [],
        addressOthers: {},
        relationships: {},
        worldKnowledge: [],
        emotionalArc: {},
      }),
    }));
  }

  /**
   * 根据角色 ID 获取单个角色信息。
   * @param characterId - 角色唯一标识
   * @returns 角色信息，如果未找到则返回 undefined
   */
  getCharacter(characterId: string): CharacterProfile | undefined {
    const row = this.db.prepare("SELECT * FROM characters WHERE id = ?").get(characterId) as CharacterRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      isPlayable: row.is_playable === 1,
      characterType: row.character_type,
      summary: row.summary,
      promptProfile: parseJson(row.prompt_profile_json, {
        name: row.name,
        role: "",
        identity: "",
        personality: [],
        selfAddress: "我",
        tone: "自然",
        typicalExpressions: [],
        forbiddenWords: [],
        forbiddenStyle: [],
        addressOthers: {},
        relationships: {},
        worldKnowledge: [],
        emotionalArc: {},
      }),
    };
  }

  /**
   * 创建新的聊天会话。
   * @param mode - 聊天模式（单聊或群聊）
   * @param participants - 参与聊天的角色 ID 列表
   * @param title - 可选的聊天标题，不提供时自动生成
   * @returns 新创建的聊天记录
   */
  createChat(mode: ChatMode, participants: string[], title?: string): ChatRecord {
    const now = Date.now();
    const chat: ChatRecord = {
      id: randomUUID(),
      title: title ?? `${mode === "single" ? "单聊" : "群聊"} ${new Date(now).toLocaleString("zh-CN")}`,
      mode,
      participants,
      mentionTarget: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(
      `INSERT INTO chats (id, title, mode, participants_json, mention_target, created_at, updated_at)
       VALUES (@id, @title, @mode, @participants_json, @mention_target, @created_at, @updated_at)`,
    ).run({
      id: chat.id,
      title: chat.title,
      mode: chat.mode,
      participants_json: JSON.stringify(chat.participants),
      mention_target: chat.mentionTarget,
      created_at: chat.createdAt,
      updated_at: chat.updatedAt,
    });

    return chat;
  }

  /**
   * 查询所有聊天会话，按最后更新时间降序排列。
   * @returns 聊天记录数组
   */
  listChats(): ChatRecord[] {
    const rows = this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all() as ChatRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      mode: row.mode,
      participants: parseJson<string[]>(row.participants_json, []),
      mentionTarget: row.mention_target,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * 根据聊天 ID 获取单个聊天会话。
   * @param chatId - 聊天唯一标识
   * @returns 聊天记录，如果未找到则返回 undefined
   */
  getChat(chatId: string): ChatRecord | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as ChatRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      mode: row.mode,
      participants: parseJson<string[]>(row.participants_json, []),
      mentionTarget: row.mention_target,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 更新聊天的最后活跃时间，并可选择更新提及目标。
   * @param chatId - 聊天唯一标识
   * @param mentionTarget - 可选的提及目标角色 ID
   */
  touchChat(chatId: string, mentionTarget?: string | null): void {
    this.db.prepare("UPDATE chats SET updated_at = @updated_at, mention_target = @mention_target WHERE id = @id").run({
      id: chatId,
      updated_at: Date.now(),
      mention_target: mentionTarget ?? null,
    });
  }

  /**
   * 向聊天中追加一条消息，并自动更新聊天的最后活跃时间。
   * @param input - 消息数据（id 和 timestamp 可选，不提供时自动生成）
   * @returns 完整保存后的消息对象
   */
  appendMessage(input: Omit<ChatMessage, "id" | "timestamp"> & { id?: string; timestamp?: number }): ChatMessage {
    const message: ChatMessage = {
      id: input.id ?? randomUUID(),
      chatId: input.chatId,
      role: input.role,
      roleId: input.roleId ?? null,
      content: input.content,
      timestamp: input.timestamp ?? Date.now(),
      metadata: input.metadata,
    };

    this.db.prepare(
      `INSERT INTO messages (id, chat_id, role, role_id, content, timestamp, metadata_json)
       VALUES (@id, @chat_id, @role, @role_id, @content, @timestamp, @metadata_json)`,
    ).run({
      id: message.id,
      chat_id: message.chatId,
      role: message.role,
      role_id: message.roleId,
      content: message.content,
      timestamp: message.timestamp,
      metadata_json: message.metadata ? JSON.stringify(message.metadata) : null,
    });

    this.touchChat(message.chatId);
    return message;
  }

  /**
   * 根据消息 ID 获取单条消息。
   * @param messageId - 消息唯一标识
   * @returns 消息对象，如果未找到则返回 undefined
   */
  getMessage(messageId: string): ChatMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1").get(messageId) as MessageRow | undefined;
    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      chatId: row.chat_id,
      role: row.role,
      roleId: row.role_id,
      content: row.content,
      timestamp: row.timestamp,
      metadata: parseJson<ChatMessageMetadata>(row.metadata_json, {}),
    };
  }

  /**
   * 更新消息的元数据。
   * @param messageId - 消息唯一标识
   * @param metadata - 新的元数据对象
   */
  updateMessageMetadata(messageId: string, metadata: ChatMessageMetadata): void {
    this.db.prepare("UPDATE messages SET metadata_json = @metadata_json WHERE id = @id").run({
      id: messageId,
      metadata_json: JSON.stringify(metadata),
    });
  }

  /**
   * 更新消息的音频数据及相关元数据。
   * @param messageId - 消息唯一标识
   * @param audio - 音频信息
   * @param extra - 额外的元数据字段
   * @throws 如果消息 ID 不存在则抛出错误
   */
  updateMessageAudio(messageId: string, audio: MessageAudio, extra: Partial<ChatMessageMetadata> = {}): void {
    const current = this.getMessage(messageId);
    if (!current) {
      throw new Error(`未找到消息 ${messageId}`);
    }

    const nextMetadata: ChatMessageMetadata = {
      ...(current.metadata ?? {}),
      ...extra,
      audio,
    };
    this.updateMessageMetadata(messageId, nextMetadata);
  }

  /**
   * 查询指定聊天的所有消息，按时间戳升序排列。
   * @param chatId - 聊天唯一标识
   * @returns 消息数组
   */
  listMessages(chatId: string): ChatMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC").all(chatId) as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      role: row.role,
      roleId: row.role_id,
      content: row.content,
      timestamp: row.timestamp,
      metadata: parseJson<ChatMessageMetadata>(row.metadata_json, {}),
    }));
  }

  listRecentMessages(chatId: string, count = 10): ChatMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?").all(chatId, count) as MessageRow[];
    return rows.reverse().map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      role: row.role,
      roleId: row.role_id,
      content: row.content,
      timestamp: row.timestamp,
      metadata: parseJson<ChatMessageMetadata>(row.metadata_json, {}),
    }));
  }

  /**
   * 删除指定聊天及其所有关联数据（消息、记忆事件、记忆摘要、核心记忆）。
   * @param chatId - 聊天唯一标识
   */
  deleteChat(chatId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM memory_events WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM memory_summaries WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM core_memories WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    })();
  }

  /**
   * 清空指定聊天的所有消息、记忆事件、记忆摘要和核心记忆，并更新聊天活跃时间。
   * @param chatId - 聊天唯一标识
   */
  clearMessages(chatId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM memory_events WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM memory_summaries WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM core_memories WHERE chat_id = ?").run(chatId);
      this.touchChat(chatId);
    })();
  }

  /**
   * 保存或更新聊天的记忆摘要。
   *
   * 当提供 characterId 时，摘要按 (chatId, characterId) 隔离存储，群聊下每个角色
   * 拥有独立摘要，避免互相覆盖。未提供时回退到会话级摘要（CHAT_LEVEL_SUMMARY_KEY），
   * 保持向后兼容。
   *
   * @param chatId      - 聊天唯一标识
   * @param summary     - 摘要内容
   * @param characterId - 角色唯一标识，群聊下必传以实现隔离
   */
  saveSummary(chatId: string, summary: string, characterId?: string): void {
    const key = characterId ?? ChatRepository.CHAT_LEVEL_SUMMARY_KEY;
    this.db.prepare(
      `INSERT INTO memory_summaries (id, chat_id, character_id, summary, created_at)
       VALUES (@id, @chat_id, @character_id, @summary, @created_at)
       ON CONFLICT(chat_id, character_id) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at`,
    ).run({ id: randomUUID(), chat_id: chatId, character_id: key, summary, created_at: Date.now() });
  }

  /**
   * 获取聊天的记忆摘要。
   *
   * 当提供 characterId 时返回该角色的专属摘要；未提供时返回会话级摘要。
   *
   * @param chatId      - 聊天唯一标识
   * @param characterId - 角色唯一标识，群聊下必传以获取对应角色摘要
   * @returns 摘要内容，如果未找到则返回 undefined
   */
  getSummary(chatId: string, characterId?: string): string | undefined {
    const key = characterId ?? ChatRepository.CHAT_LEVEL_SUMMARY_KEY;
    const row = this.db.prepare("SELECT summary FROM memory_summaries WHERE chat_id = ? AND character_id = ?").get(chatId, key) as { summary: string } | undefined;
    return row?.summary;
  }

  /**
   * 保存一条记忆事件。
   * @param event - 记忆事件对象
   */
  saveMemory(event: MemoryEvent): void {
    this.db.prepare(
      `INSERT INTO memory_events (id, chat_id, session_id, character, content, category, timestamp, tags_json, source_message_id, summary, emotion, importance, key_points_json)
       VALUES (@id, @chat_id, @session_id, @character, @content, @category, @timestamp, @tags_json, @source_message_id, @summary, @emotion, @importance, @key_points_json)`,
    ).run({
      id: event.id,
      chat_id: event.chatId,
      session_id: event.sessionId,
      character: event.character,
      content: event.content,
      category: event.category,
      timestamp: event.timestamp,
      tags_json: JSON.stringify(event.tags),
      source_message_id: event.sourceMessageId ?? null,
      summary: event.summary ?? null,
      emotion: event.emotion ?? null,
      importance: event.importance ?? null,
      key_points_json: event.keyPoints ? JSON.stringify(event.keyPoints) : null,
    });
  }

  listMemoryEvents(chatId: string, limit = 20, character?: string): MemoryEvent[] {
    const rows = character
      ? this.db.prepare("SELECT * FROM memory_events WHERE chat_id = ? AND character = ? ORDER BY timestamp DESC LIMIT ?").all(chatId, character, limit) as MemoryRow[]
      : this.db.prepare("SELECT * FROM memory_events WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?").all(chatId, limit) as MemoryRow[];
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      sessionId: row.session_id,
      character: row.character,
      content: row.content,
      category: row.category,
      timestamp: row.timestamp,
      tags: parseJson<string[]>(row.tags_json, []),
      sourceMessageId: row.source_message_id ?? undefined,
      summary: row.summary ?? undefined,
      emotion: row.emotion ?? undefined,
      importance: row.importance ?? undefined,
      keyPoints: row.key_points_json ? parseJson<string[]>(row.key_points_json, []) : undefined,
    }));
  }

  /**
   * 保存或更新核心记忆。如果 (chatId, characterId) 组合已存在则更新。
   * @param memory - 核心记忆对象
   */
  saveCoreMemory(memory: import("../../common/types").CoreMemory): void {
    this.db.prepare(
      `INSERT INTO core_memories (id, chat_id, character_id, user_preferences_json, user_traits_json, relationship_stage, relationship_notes_json, key_facts_json, last_updated)
       VALUES (@id, @chat_id, @character_id, @user_preferences_json, @user_traits_json, @relationship_stage, @relationship_notes_json, @key_facts_json, @last_updated)
       ON CONFLICT(chat_id, character_id) DO UPDATE SET
         user_preferences_json = excluded.user_preferences_json,
         user_traits_json = excluded.user_traits_json,
         relationship_stage = excluded.relationship_stage,
         relationship_notes_json = excluded.relationship_notes_json,
         key_facts_json = excluded.key_facts_json,
         last_updated = excluded.last_updated`
    ).run({
      id: memory.id, chat_id: memory.chatId, character_id: memory.character,
      user_preferences_json: JSON.stringify(memory.userPreferences),
      user_traits_json: JSON.stringify(memory.userTraits),
      relationship_stage: memory.relationshipStage,
      relationship_notes_json: JSON.stringify(memory.relationshipNotes),
      key_facts_json: JSON.stringify(memory.keyFacts),
      last_updated: memory.lastUpdated,
    });
  }

  /**
   * 获取指定聊天和角色的核心记忆。
   * @param chatId - 聊天唯一标识
   * @param characterId - 角色唯一标识
   * @returns 核心记忆对象，如果未找到则返回 undefined
   */
  getCoreMemory(chatId: string, characterId: string): import("../../common/types").CoreMemory | undefined {
    const row = this.db.prepare("SELECT * FROM core_memories WHERE chat_id = ? AND character_id = ? LIMIT 1").get(chatId, characterId) as CoreMemoryRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id, chatId: row.chat_id, character: row.character_id,
      userPreferences: parseJson<string[]>(row.user_preferences_json, []),
      userTraits: parseJson<string[]>(row.user_traits_json, []),
      relationshipStage: row.relationship_stage,
      relationshipNotes: parseJson<string[]>(row.relationship_notes_json, []),
      keyFacts: parseJson<string[]>(row.key_facts_json, []),
      lastUpdated: row.last_updated,
    };
  }

  /**
   * 关闭数据库连接。
   */
  close(): void {
    this.db.close();
  }
}
