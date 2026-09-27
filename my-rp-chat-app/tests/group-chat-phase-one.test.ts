import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../src/backend/db/database";
import { GroupChatCoordinator } from "../src/backend/graph/group-coordinator";
import type { StructuredCompletionRequest } from "../src/backend/services/llm/llm-service";
import type { CharacterProfile, GroupChatRoomConfig } from "../src/common/types";

const directories: string[] = [];
const roles = ["芳乃", "茉子", "丛雨"];

function character(id: string): CharacterProfile {
  return {
    id, name: id, displayName: id, isPlayable: true, characterType: "playable", summary: id,
    promptProfile: {
      name: id, role: "heroine", identity: id, personality: ["gentle"], selfAddress: "我",
      tone: "温柔", typicalExpressions: ["你好"], forbiddenWords: [], forbiddenStyle: [],
      addressOthers: {}, relationships: {}, worldKnowledge: [], emotionalArc: {},
    },
  };
}

function repository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "senren-group-phase-one-"));
  directories.push(directory);
  const db = new ChatRepository(path.join(directory, "chat.sqlite"));
  db.init();
  db.upsertCharacters(roles.map(character));
  return { db, directory };
}

async function run(config: Partial<GroupChatRoomConfig>, mentionTarget: string | null = null) {
  const { db } = repository();
  const chat = db.createChat("group", roles, "群聊", config);
  db.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });
  let generated = 0;
  const publish = vi.fn();
  const coordinator = new GroupChatCoordinator({
    repository: db,
    characterService: {} as never,
    elasticsearchService: { hybridSearch: vi.fn().mockResolvedValue([]) } as never,
    llmService: {
      streamStructuredCompletion: vi.fn().mockImplementation(async ({ onToken }: StructuredCompletionRequest) => {
        const content = `我回应第${++generated}次`;
        await onToken(content);
        return { content, speechTextJa: "", raw: "{}" };
      }),
    } as never,
    memoryService: {
      recall: vi.fn().mockResolvedValue([]), getSummary: vi.fn().mockReturnValue(undefined),
      getCoreMemory: vi.fn().mockReturnValue(null), extractAndPersist: vi.fn().mockResolvedValue(null),
      consolidateCoreMemory: vi.fn().mockResolvedValue(null),
    } as never,
    sseService: { publish } as never,
  }, chat.roomConfig, 2, 0);
  await coordinator.runSession({
    chatId: chat.id, streamId: "test-stream", participants: roles, mentionTarget,
    messages: db.listMessages(chat.id),
  });
  const messages = db.listMessages(chat.id).filter((message) => message.role === "assistant");
  return { db, messages, publish };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("current group coordinator room modes", () => {
  it("limits directed replies to the selected role in every room mode", async () => {
    for (const mode of ["single_round", "free_chat", "host_mode"] as const) {
      const { db, messages, publish } = await run(
        { mode, hostRoleId: mode === "host_mode" ? "茉子" : null }, "丛雨",
      );
      expect(messages.map((message) => message.roleId)).toEqual(["丛雨"]);
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({
        type: "round_plan", plannedSpeakers: ["丛雨"],
      }));
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({
        type: "room_finished", generatedCount: 1, reason: "仅定向角色回复",
      }));
      db.close();
    }
  });

  it("keeps normal single round participation and gives free chat two rounds", async () => {
    const single = await run({ mode: "single_round" });
    expect(single.messages.map((message) => message.roleId)).toEqual(roles);
    single.db.close();

    const free = await run({ mode: "free_chat" });
    expect(free.messages.map((message) => message.roleId)).toEqual([...roles, ...roles]);
    free.db.close();
  });

  it("starts a host room with the explicitly chosen host", async () => {
    const { db, messages } = await run({ mode: "host_mode", hostRoleId: "茉子" });
    expect(messages[0]?.roleId).toBe("茉子");
    db.close();
  });
});

describe("legacy free chat budget migration", () => {
  it("upgrades only rooms matching the old default and persists the result", () => {
    const { db, directory } = repository();
    const old = db.createChat("group", roles, "旧默认");
    const custom = db.createChat("group", roles, "自定义");
    db.close();
    const pathToDb = path.join(directory, "chat.sqlite");
    const raw = new Database(pathToDb);
    const update = raw.prepare("UPDATE chats SET room_config_json = ? WHERE id = ?");
    update.run(JSON.stringify({ mode: "free_chat", maxRounds: 1, maxMessages: 3 }), old.id);
    update.run(JSON.stringify({ mode: "free_chat", maxRounds: 1, maxMessages: 5 }), custom.id);
    raw.close();

    const reopened = new ChatRepository(pathToDb);
    reopened.init();
    expect(reopened.getChat(old.id)?.roomConfig).toMatchObject({ maxRounds: 2, maxMessages: 6 });
    expect(reopened.getChat(custom.id)?.roomConfig).toMatchObject({ maxRounds: 1, maxMessages: 5 });
    reopened.close();
  });
});
