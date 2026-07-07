import type Database from "better-sqlite3";

export function initDatabaseSchema(db: Database.Database, chatLevelSummaryKey: string): void {
  db.exec(`
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
      room_config_json TEXT,
      room_state_json TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_chat_id_session ON memory_events(chat_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_character ON memory_events(chat_id, character);
    CREATE INDEX IF NOT EXISTS idx_core_memories_chat_id ON core_memories(chat_id);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_chat_id ON memory_summaries(chat_id);
  `);

  ensureMemoryEventColumns(db);
  ensureChatColumns(db);
  migrateMemorySummariesForCharacterIsolation(db, chatLevelSummaryKey);
}

function ensureChatColumns(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const required: Array<{ name: string; def: string }> = [
    { name: "room_config_json", def: "TEXT" },
    { name: "room_state_json", def: "TEXT" },
  ];

  for (const column of required) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE chats ADD COLUMN ${column.name} ${column.def}`);
    }
  }
}

function ensureMemoryEventColumns(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const required: Array<{ name: string; def: string }> = [
    { name: "summary", def: "TEXT" },
    { name: "emotion", def: "TEXT" },
    { name: "importance", def: "INTEGER" },
    { name: "key_points_json", def: "TEXT" },
  ];

  for (const column of required) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE memory_events ADD COLUMN ${column.name} ${column.def}`);
    }
  }
}

function migrateMemorySummariesForCharacterIsolation(
  db: Database.Database,
  chatLevelSummaryKey: string,
): void {
  const columns = db.prepare("PRAGMA table_info(memory_summaries)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  if (existing.has("character_id")) {
    return;
  }

  db.exec(`
    ALTER TABLE memory_summaries RENAME TO memory_summaries_old;
    CREATE TABLE memory_summaries (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      character_id TEXT NOT NULL DEFAULT '${chatLevelSummaryKey}',
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(chat_id, character_id)
    );
    INSERT INTO memory_summaries (id, chat_id, character_id, summary, created_at)
      SELECT id, chat_id, '${chatLevelSummaryKey}', summary, created_at
      FROM memory_summaries_old;
    DROP TABLE memory_summaries_old;
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_chat_id ON memory_summaries(chat_id);
  `);
}
