import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../src/backend/db/database";
import type { CharacterProfile } from "../src/common/types";

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
});
