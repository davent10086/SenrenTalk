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

async function run(
  config: Partial<GroupChatRoomConfig>,
  mentionTarget: string | null = null,
  responseFor?: (roleId: string, call: number, prompt: string) => { content?: string; nextSpeaker?: string; skip?: boolean },
  signal?: AbortSignal,
  options?: { previous?: { roleId: string; content: string }; ttsService?: unknown },
) {
  const { db } = repository();
  const chat = db.createChat("group", roles, "群聊", config);
  if (options?.previous) db.appendMessage({
    chatId: chat.id, role: "assistant", roleId: options.previous.roleId, content: options.previous.content,
  });
  db.appendMessage({ chatId: chat.id, role: "user", content: "大家好" });
  let generated = 0;
  const publish = vi.fn();
  const coordinator = new GroupChatCoordinator({
    repository: db,
    abortSignal: signal,
    characterService: {} as never,
    elasticsearchService: { hybridSearch: vi.fn().mockResolvedValue([]) } as never,
    llmService: {
      streamStructuredCompletion: vi.fn().mockImplementation(async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
        const roleId = systemPrompt.match(/当前角色：([^\n]+)/)?.[1] ?? "";
        const reply = responseFor?.(roleId, ++generated, systemPrompt) ?? {};
        const content = reply.content ?? `我回应第${generated}次`;
        if (!reply.skip) await onToken(content);
        return { content, speechTextJa: "", raw: "{}", nextSpeaker: reply.nextSpeaker, skip: reply.skip };
      }),
    } as never,
    memoryService: {
      recall: vi.fn().mockResolvedValue([]), getSummary: vi.fn().mockReturnValue(undefined),
      getCoreMemory: vi.fn().mockReturnValue(null), extractAndPersist: vi.fn().mockResolvedValue(null),
      consolidateCoreMemory: vi.fn().mockResolvedValue(null),
    } as never,
    sseService: { publish } as never,
    ttsService: options?.ttsService as never,
  }, chat.roomConfig, 2, 0);
  try {
    await coordinator.runSession({
      chatId: chat.id, streamId: "test-stream", participants: roles, mentionTarget,
      messages: db.listMessages(chat.id),
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const messages = db.listMessages(chat.id).filter((message) => message.role === "assistant");
  return { db, messages, publish };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("current group coordinator room modes", () => {
  it("commits only the rewritten reply after a duplicate draft", async () => {
    const synthesize = vi.fn().mockResolvedValue({ status: "ready", voiceId: "test" });
    const ttsService = { isEnabled: () => true, resolveVoiceId: () => "test", synthesize };
    const { db, messages, publish } = await run({ mode: "single_round" }, "芳乃",
      (_roleId, call) => ({ content: call === 1 ? "我重复旧回复" : "我改写后的新回复" }),
      undefined, { previous: { roleId: "芳乃", content: "我重复旧回复" }, ttsService });
    expect(messages.map((message) => message.content)).toEqual(["我重复旧回复", "我改写后的新回复"]);
    const events = publish.mock.calls.map(([event]) => event);
    const resets = events.filter((event) => event.type === "draft_reset");
    const done = events.filter((event) => event.type === "message_done");
    expect(resets).toHaveLength(2);
    expect(resets[0].attemptId).not.toBe(resets[1].attemptId);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ attemptId: resets[1].attemptId, content: "我改写后的新回复" });
    expect(events.findIndex((event) => event.type === "message_done"))
      .toBeGreaterThan(events.findIndex((event) => event.type === "draft_reset" && event.attemptId === resets[1].attemptId));
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ messageId: done[0].messageId }));
    db.close();
  });

  it("does not save or synthesize either repeated candidate", async () => {
    const synthesize = vi.fn();
    const { db, messages, publish } = await run({ mode: "single_round" }, "芳乃",
      () => ({ content: "我重复旧回复" }), undefined,
      { previous: { roleId: "芳乃", content: "我重复旧回复" },
        ttsService: { isEnabled: () => true, resolveVoiceId: () => "test", synthesize } });
    expect(messages.map((message) => message.content)).toEqual(["我重复旧回复"]);
    expect(publish.mock.calls.filter(([event]) => event.type === "message_done")).toHaveLength(0);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "role_skipped", reason: "similar_to_last" }));
    expect(synthesize).not.toHaveBeenCalled();
    db.close();
  });

  it("resets the draft on graph validation retry and commits only the valid result", async () => {
    const { db, messages, publish } = await run({ mode: "single_round" }, "芳乃",
      (_roleId, call) => ({ content: call === 1 ? "晚安" : "我今晚会留下来" }));
    expect(messages.map((message) => message.content)).toEqual(["我今晚会留下来"]);
    const events = publish.mock.calls.map(([event]) => event);
    const resets = events.filter((event) => event.type === "draft_reset");
    const done = events.filter((event) => event.type === "message_done");
    expect(resets).toHaveLength(2);
    expect(done).toHaveLength(1);
    expect(done[0].attemptId).toBe(resets[1].attemptId);
    db.close();
  });
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

  it("keeps normal single round participation and ends free chat without nominations", async () => {
    const single = await run({ mode: "single_round" });
    expect(single.messages.map((message) => message.roleId)).toEqual(roles);
    single.db.close();

    const free = await run({ mode: "free_chat" });
    expect(free.messages.map((message) => message.roleId)).toEqual(roles);
    free.db.close();
  });

  it("starts a host room with the explicitly chosen host", async () => {
    const { db, messages } = await run({ mode: "host_mode", hostRoleId: "茉子" });
    expect(messages[0]?.roleId).toBe("茉子");
    db.close();
  });

  it("immediately follows a valid nomination and records the actual reply target", async () => {
    const { db, messages, publish } = await run({ mode: "free_chat" }, null,
      (roleId) => ({ nextSpeaker: roleId === "芳乃" ? "丛雨" : undefined }));
    expect(messages.map((message) => message.roleId)).toEqual(["芳乃", "丛雨", "茉子"]);
    expect(messages[1].metadata).toMatchObject({
      replyToMessageId: messages[0].id, replyToRoleId: "芳乃", generationReason: "nominated",
    });
    expect(publish.mock.calls.filter(([event]) => event.type === "round_plan")
      .map(([event]) => event.plannedSpeakers[0])).toEqual(["芳乃", "丛雨", "茉子"]);
    db.close();
  });

  it("ignores self and out-of-room nominations and falls back to the remaining roles", async () => {
    const { db, messages } = await run({ mode: "free_chat" }, null,
      (roleId) => ({ nextSpeaker: roleId === "芳乃" ? "芳乃" : "路人" }));
    expect(messages.map((message) => message.roleId)).toEqual(roles);
    db.close();
  });

  it("defers a nomination of an already attempted role to the next round", async () => {
    const { db, messages } = await run({ mode: "free_chat" }, null,
      (roleId, call) => ({ nextSpeaker: roleId === "茉子" && call === 2 ? "芳乃" : undefined }));
    expect(messages.map((message) => message.roleId).slice(0, 4)).toEqual(["芳乃", "茉子", "丛雨", "芳乃"]);
    expect(messages[3].metadata).toMatchObject({ round: 2, generationReason: "nominated" });
    db.close();
  });

  it("lets any participant nominate in host mode and gives the host one optional closing turn", async () => {
    const { db, messages, publish } = await run({ mode: "host_mode", hostRoleId: "茉子" }, null,
      (roleId) => ({ nextSpeaker: roleId === "芳乃" ? "丛雨" : undefined }));
    expect(messages.map((message) => message.roleId)).toEqual(["茉子", "芳乃", "丛雨", "茉子"]);
    expect(messages[2].metadata?.generationReason).toBe("nominated");
    expect(messages[3].metadata?.generationReason).toBe("host_closing");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "room_finished", reason: "主持人已收尾",
    }));
    db.close();
  });

  it("does not claim a host closing when the host skips or the budget is exhausted", async () => {
    const skipped = await run({ mode: "host_mode", hostRoleId: "茉子" }, null,
      (_roleId, _call, prompt) => prompt.includes("主持收尾") ? { skip: true } : {});
    expect(skipped.messages.map((message) => message.roleId)).toEqual(["茉子", "芳乃", "丛雨"]);
    expect(skipped.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "room_finished", reason: "主持人没有新的收尾内容",
    }));
    skipped.db.close();

    const capped = await run({ mode: "host_mode", hostRoleId: "茉子", maxMessages: 3 });
    expect(capped.messages).toHaveLength(3);
    expect(capped.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "room_finished", reason: "达到本房间消息上限",
    }));
    capped.db.close();
  });

  it("allows a guest nomination to reopen a configured second host round", async () => {
    const { db, messages } = await run({
      mode: "host_mode", hostRoleId: "茉子", maxRounds: 2, maxMessages: 6,
    }, null, (roleId, call) => ({ nextSpeaker: roleId === "芳乃" && call === 2 ? "茉子" : undefined }));
    expect(messages.map((message) => message.roleId).slice(0, 4)).toEqual(["茉子", "芳乃", "丛雨", "茉子"]);
    expect(messages[3].metadata).toMatchObject({ round: 2, generationReason: "nominated" });
    db.close();
  });

  it("continues after a skip or role failure and reports both", async () => {
    const { db, messages, publish } = await run({ mode: "free_chat" }, null,
      (roleId) => {
        if (roleId === "茉子") return { skip: true };
        if (roleId === "丛雨") throw new Error("模型失败");
        return {};
      });
    expect(messages.map((message) => message.roleId)).toEqual(["芳乃"]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "round_stats", skipped: ["茉子"], failed: ["丛雨"],
    }));
    expect(publish.mock.calls.filter(([event]) => event.type === "message_done")
      .map(([event]) => event.roleId)).toEqual(["芳乃"]);
    db.close();
  });

  it("stops at the message cap even with a pending nomination", async () => {
    const { db, messages, publish } = await run({ mode: "free_chat", maxMessages: 2 }, null,
      (roleId) => ({ nextSpeaker: roleId === "芳乃" ? "丛雨" : undefined }));
    expect(messages.map((message) => message.roleId)).toEqual(["芳乃", "丛雨"]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "room_finished", reason: "达到本房间消息上限",
    }));
    db.close();
  });

  it("propagates cancellation without continuing to another role", async () => {
    const controller = new AbortController();
    await expect(run({ mode: "free_chat" }, null,
      () => { controller.abort(); return {}; }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
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
