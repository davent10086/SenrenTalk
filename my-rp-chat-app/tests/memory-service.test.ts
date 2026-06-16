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
    } as never);

    const result = await service.extractAndPersist(chat.id, character, repository.listMessages(chat.id));

    expect(result?.sourceMessageId).toBeDefined();
    expect(indexMemory).toHaveBeenCalledTimes(1);
    expect(repository.listMemoryEvents(chat.id)).toHaveLength(1);
    expect(repository.getSummary(chat.id)).toContain(userMessage.content);
    repository.close();
  });
});
