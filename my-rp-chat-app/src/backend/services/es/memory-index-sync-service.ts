import type { ChatRepository } from "../../db/database";
import type { MemoryIndexOperation } from "../../db/memory-index-outbox";
import type { ElasticsearchService } from "./elasticsearch-service";

/** Drains durable SQLite work in bounded batches; callers may safely retry. */
export class MemoryIndexSyncService {
  private draining: Promise<void> | undefined;

  constructor(
    private readonly repository: ChatRepository,
    private readonly elasticsearch: ElasticsearchService,
  ) {}

  async drain(limit = 100): Promise<void> {
    if (!this.elasticsearch.enabled) return;
    if (this.draining) return this.draining;
    this.draining = this.drainOnce(limit).finally(() => { this.draining = undefined; });
    return this.draining;
  }

  private async drainOnce(limit: number): Promise<void> {
    const operations = this.repository.listMemoryIndexOperations(limit);
    if (!operations.length) return;
    const resolved = operations.flatMap((operation) => this.resolve(operation));
    await this.elasticsearch.applyMemoryIndexOperations(resolved);
    this.repository.acknowledgeMemoryIndexOperations(operations.map((operation) => operation.id));
  }

  private resolve(operation: MemoryIndexOperation): MemoryIndexOperation & { event?: import("../../../common/types").MemoryEvent } {
    if (operation.kind !== "upsert") return operation;
    const event = this.repository.getIndexableMemoryEvent(operation.chatId, operation.eventId);
    return event ? { ...operation, event } : { ...operation, kind: "delete" };
  }
}
