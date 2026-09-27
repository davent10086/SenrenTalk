import type { ChatMessage, CoreMemory, CoreMemoryCandidate, MemoryEvent } from "../../common/types";
import type { MemoryIndexOutboxRepository } from "./memory-index-outbox";

/**
 * Persistence boundary used by memory workflows.  Keeping this contract small
 * prevents graph, session and LLM concerns from leaking into memory storage.
 */
export interface MemoryRepository {
  readonly memoryIndexOutbox: MemoryIndexOutboxRepository;
  getMemoryEpoch(chatId: string, characterId: string): number;
  saveSummaryIfSourceCurrent(chatId: string, characterId: string, summary: string, messages: ChatMessage[], expectedEpoch: number): boolean;
  getSummary(chatId: string, characterId?: string): string | undefined;
  saveMemoryIfSourceCurrent(event: MemoryEvent, sourceContent: string, expectedEpoch: number): MemoryEvent | undefined;
  getRecallableEvents(chatId: string, character: string | undefined, ids: string[]): Map<string, MemoryEvent>;
  listTimelineEvents(chatId: string, character?: string, status?: "pending" | "confirmed" | "dismissed"): MemoryEvent[];
  getMemoryEvent(chatId: string, id: string): MemoryEvent | undefined;
  updateMemoryStatus(chatId: string, id: string, status: "confirmed" | "dismissed"): MemoryEvent | undefined;
  supersedeConflictingFacts(event: MemoryEvent): string[];
  clearDerivedMemory(chatId: string, character: string): void;
  deleteConfirmedMemory(chatId: string, id: string): MemoryEvent | undefined;
  getCoreMemory(chatId: string, character: string): CoreMemory | undefined;
  getCoreCandidate(chatId: string, characterId: string): CoreMemoryCandidate | undefined;
  getConsolidationSequence(chatId: string, characterId: string): number;
  saveCoreCandidateIfCurrent(candidate: CoreMemoryCandidate, expectedCursor: number): boolean;
  listCoreMemories(chatId: string): CoreMemory[];
  listCoreCandidates(chatId: string): CoreMemoryCandidate[];
  confirmCoreCandidateAtomic(chatId: string, characterId: string, candidateId: string, core: CoreMemory): CoreMemory | undefined;
  setConsolidationSequence(chatId: string, characterId: string, sequence: number): void;
  deleteCoreCandidate(chatId: string, characterId: string): void;
  getCharacter(characterId: string): import("../../common/types").CharacterProfile | undefined;
}
