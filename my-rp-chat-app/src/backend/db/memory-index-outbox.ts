import type Database from "better-sqlite3";
import type { MemoryEvent } from "../../common/types";

export type MemoryIndexOperation =
  | { id: number; kind: "upsert" | "delete"; chatId: string; eventId: string }
  | { id: number; kind: "delete-session"; chatId: string; eventId: string };

/**
 * Durable, coalescing work list for the derived Elasticsearch memory index.
 * SQLite remains authoritative: losing or delaying this queue only affects
 * recall quality, never the user's saved memory.
 */
export class MemoryIndexOutboxRepository {
  constructor(private readonly db: Database.Database) {}

  queueUpsert(event: MemoryEvent): void {
    this.queue(event.chatId, event.id, "upsert");
  }

  queueDelete(chatId: string, eventId: string): void {
    this.queue(chatId, eventId, "delete");
  }

  queueDeleteSession(chatId: string): void {
    this.db.prepare("DELETE FROM memory_index_outbox WHERE chat_id = ?").run(chatId);
    this.queue(chatId, `session:${chatId}`, "delete-session");
  }

  queueSessionResync(chatId: string, events: MemoryEvent[]): void {
    this.queueDeleteSession(chatId);
    events.forEach((event) => this.queueUpsert(event));
  }

  list(limit = 100): MemoryIndexOperation[] {
    const rows = this.db.prepare(`SELECT id, kind, chat_id, event_id FROM memory_index_outbox
      ORDER BY id ASC LIMIT ?`).all(limit) as Array<{ id: number; kind: MemoryIndexOperation["kind"]; chat_id: string; event_id: string }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, chatId: row.chat_id, eventId: row.event_id }));
  }

  acknowledge(ids: number[]): void {
    if (!ids.length) return;
    this.db.prepare(`DELETE FROM memory_index_outbox WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }

  private queue(chatId: string, eventId: string, kind: MemoryIndexOperation["kind"]): void {
    this.db.prepare(`INSERT INTO memory_index_outbox (kind, chat_id, event_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET kind = excluded.kind, chat_id = excluded.chat_id, created_at = excluded.created_at`)
      .run(kind, chatId, eventId, Date.now());
  }
}
