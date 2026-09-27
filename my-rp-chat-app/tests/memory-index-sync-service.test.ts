import { describe, expect, it, vi } from "vitest";
import { MemoryIndexSyncService } from "../src/backend/services/es/memory-index-sync-service";

describe("MemoryIndexSyncService", () => {
  it("keeps SQLite work pending when Elasticsearch cannot apply a batch", async () => {
    const repository = {
      listMemoryIndexOperations: vi.fn(() => [{ id: 1, kind: "delete" as const, chatId: "chat", eventId: "event" }]),
      getIndexableMemoryEvent: vi.fn(),
      acknowledgeMemoryIndexOperations: vi.fn(),
    };
    const elasticsearch = { enabled: true, applyMemoryIndexOperations: vi.fn().mockRejectedValue(new Error("offline")) };
    const service = new MemoryIndexSyncService(repository as never, elasticsearch as never);

    await expect(service.drain()).rejects.toThrow("offline");
    expect(repository.acknowledgeMemoryIndexOperations).not.toHaveBeenCalled();
  });

  it("resolves stale upserts to deletes and acknowledges only after Elasticsearch accepts them", async () => {
    const repository = {
      listMemoryIndexOperations: vi.fn(() => [{ id: 1, kind: "upsert" as const, chatId: "chat", eventId: "deleted-event" }]),
      getIndexableMemoryEvent: vi.fn(() => undefined),
      acknowledgeMemoryIndexOperations: vi.fn(),
    };
    const elasticsearch = { enabled: true, applyMemoryIndexOperations: vi.fn().mockResolvedValue(undefined) };
    const service = new MemoryIndexSyncService(repository as never, elasticsearch as never);

    await service.drain();
    expect(elasticsearch.applyMemoryIndexOperations).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "delete", eventId: "deleted-event" }),
    ]);
    expect(repository.acknowledgeMemoryIndexOperations).toHaveBeenCalledWith([1]);
  });
});
