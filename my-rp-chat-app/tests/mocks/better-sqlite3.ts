type Row = Record<string, unknown>;

class Statement {
  constructor(
    private readonly sql: string,
    private readonly db: MockDatabase,
  ) {}

  run(params?: Row, ...args: unknown[]): void {
    const sql = normalizeSql(this.sql);
    this.db.execute(sql, params, args);
  }

  get(...args: unknown[]): Row | undefined {
    const sql = normalizeSql(this.sql);
    return this.db.queryOne(sql, args);
  }

  all(...args: unknown[]): Row[] {
    const sql = normalizeSql(this.sql);
    return this.db.queryAll(sql, args);
  }
}

class MockDatabase {
  private readonly characters = new Map<string, Row>();
  private readonly chats = new Map<string, Row>();
  private readonly messages = new Map<string, Row>();
  private readonly memoryEvents = new Map<string, Row>();
  private readonly memorySummaries = new Map<string, Row>();

  pragma(): void {}

  exec(): void {}

  close(): void {}

  prepare(sql: string): Statement {
    return new Statement(sql, this);
  }

  transaction<TArgs extends unknown[]>(fn: (...args: TArgs) => void): (...args: TArgs) => void {
    return (...args: TArgs) => fn(...args);
  }

  execute(sql: string, params?: Row, args: unknown[] = []): void {
    if (sql.startsWith("INSERT INTO characters")) {
      this.characters.set(String(params?.id), { ...params });
      return;
    }
    if (sql.startsWith("INSERT INTO chats")) {
      this.chats.set(String(params?.id), { ...params });
      return;
    }
    if (sql.startsWith("UPDATE chats SET updated_at")) {
      const current = this.chats.get(String(params?.id));
      if (current) {
        this.chats.set(String(params?.id), {
          ...current,
          updated_at: params?.updated_at,
          mention_target: params?.mention_target ?? null,
        });
      }
      return;
    }
    if (sql.startsWith("INSERT INTO messages")) {
      this.messages.set(String(params?.id), { ...params });
      return;
    }
    if (sql.startsWith("UPDATE messages SET metadata_json")) {
      const current = this.messages.get(String(params?.id));
      if (current) {
        this.messages.set(String(params?.id), {
          ...current,
          metadata_json: params?.metadata_json ?? null,
        });
      }
      return;
    }
    if (sql.startsWith("DELETE FROM messages WHERE chat_id = ?")) {
      const [chatId] = args;
      deleteByField(this.messages, "chat_id", chatId);
      return;
    }
    if (sql.startsWith("INSERT INTO memory_events")) {
      this.memoryEvents.set(String(params?.id), { ...params });
      return;
    }
    if (sql.startsWith("DELETE FROM memory_events WHERE chat_id = ?")) {
      const [chatId] = args;
      deleteByField(this.memoryEvents, "chat_id", chatId);
      return;
    }
    if (sql.startsWith("INSERT INTO memory_summaries")) {
      const existing = Array.from(this.memorySummaries.values()).find(
        (row) => row.chat_id === params?.chat_id,
      );
      const id = existing?.id ?? params?.id;
      this.memorySummaries.set(String(id), {
        id,
        chat_id: params?.chat_id,
        summary: params?.summary,
        created_at: params?.created_at,
      });
      return;
    }
    if (sql.startsWith("DELETE FROM memory_summaries WHERE chat_id = ?")) {
      const [chatId] = args;
      deleteByField(this.memorySummaries, "chat_id", chatId);
      return;
    }

    throw new Error(`MockDatabase 未实现 run: ${sql}`);
  }

  queryOne(sql: string, args: unknown[] = []): Row | undefined {
    if (sql.startsWith("SELECT * FROM messages WHERE id = ?")) {
      return this.messages.get(String(args[0]));
    }
    if (sql.startsWith("SELECT summary FROM memory_summaries WHERE chat_id = ?")) {
      const row = Array.from(this.memorySummaries.values()).find(
        (summary) => summary.chat_id === args[0],
      );
      return row ? { summary: row.summary } : undefined;
    }

    throw new Error(`MockDatabase 未实现 get: ${sql}`);
  }

  queryAll(sql: string, args: unknown[] = []): Row[] {
    if (sql.startsWith("SELECT * FROM characters ORDER BY")) {
      return Array.from(this.characters.values()).sort((left, right) => {
        const playableDiff = Number(right.is_playable) - Number(left.is_playable);
        if (playableDiff !== 0) {
          return playableDiff;
        }
        return String(left.name).localeCompare(String(right.name));
      });
    }
    if (sql.startsWith("SELECT * FROM chats ORDER BY updated_at DESC")) {
      return Array.from(this.chats.values()).sort(
        (left, right) => Number(right.updated_at) - Number(left.updated_at),
      );
    }
    if (sql.startsWith("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC")) {
      return Array.from(this.messages.values())
        .filter((message) => message.chat_id === args[0])
        .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
    }
    if (sql.startsWith("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?")) {
      return Array.from(this.messages.values())
        .filter((message) => message.chat_id === args[0])
        .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))
        .slice(0, Number(args[1]));
    }
    if (sql.startsWith("SELECT * FROM memory_events WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?")) {
      return Array.from(this.memoryEvents.values())
        .filter((event) => event.chat_id === args[0])
        .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))
        .slice(0, Number(args[1]));
    }

    throw new Error(`MockDatabase 未实现 all: ${sql}`);
  }
}

function deleteByField(store: Map<string, Row>, field: string, value: unknown): void {
  Array.from(store.entries()).forEach(([key, row]) => {
    if (row[field] === value) {
      store.delete(key);
    }
  });
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export default MockDatabase;
