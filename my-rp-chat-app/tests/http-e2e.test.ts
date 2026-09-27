import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "../src/server/api-service";
import { startWebServer, type StartedWebServer } from "../src/server/index";
import type { CharacterProfile } from "../src/common/types";
import { cleanupTempDirs, createTempDir } from "./helpers/temp-dir";

const character: CharacterProfile = {
  id: "芳乃", name: "芳乃", displayName: "芳乃", isPlayable: true, characterType: "playable", summary: "测试角色",
  promptProfile: { name: "芳乃", role: "heroine", identity: "测试", personality: [], selfAddress: "我", tone: "自然", typicalExpressions: [], forbiddenWords: [], forbiddenStyle: [], addressOthers: {}, relationships: {}, worldKnowledge: [], emotionalArc: {} },
};

let started: StartedWebServer | undefined;

afterEach(async () => {
  await started?.dispose();
  started = undefined;
  await cleanupTempDirs();
});

describe("HTTP E2E: chat send", () => {
  it("persists a multipart message, streams the generated reply, and exposes both through HTTP", async () => {
    const directory = createTempDir("senren-http-e2e-");
    const api = new ApiService(directory, directory);
    Object.assign(api.runtime.characterService, { loadCharacters: vi.fn().mockResolvedValue([character]) });
    Object.assign(api.runtime.elasticsearchService, { ensureMemoryIndex: vi.fn().mockResolvedValue(undefined) });
    await api.start();
    Object.assign(api.runtime.llmService, {
      extractTags: vi.fn().mockResolvedValue({}),
      streamStructuredCompletion: vi.fn(async ({ onToken }: { onToken: (token: string) => Promise<void> }) => {
        await onToken("我是芳乃，收到图片了。 ");
        return { content: "我是芳乃，收到图片了。", speechTextJa: "わかったよ。", raw: "{}" };
      }),
    });
    Object.assign(api.runtime.elasticsearchService, { hybridSearch: vi.fn().mockResolvedValue([]) });
    Object.assign(api.runtime.memoryService, { recall: vi.fn().mockResolvedValue([]), getSummary: vi.fn(), getCoreMemory: vi.fn(), extractAndPersist: vi.fn().mockResolvedValue(null) });
    started = await startWebServer({ api, appRoot: directory, userDataPath: directory, port: 0 });

    const create = await fetch(`${started.baseUrl}/api/chats`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "single", participants: [character.id], title: "HTTP E2E" }),
    });
    expect(create.status).toBe(200);
    const chat = await create.json() as { id: string };

    const form = new FormData();
    form.set("content", "这是谁？"); form.set("mode", "single"); form.set("participants", JSON.stringify([character.id]));
    form.set("attachmentsMeta", JSON.stringify([{ id: "image-1", kind: "image", originalName: "test.png", mimeType: "image/png", size: 4 }]));
    form.append("files", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "test.png");
    const send = await fetch(`${started.baseUrl}/api/chats/${chat.id}/send`, { method: "POST", body: form });
    expect(send.status).toBe(200);
    const result = await send.json() as { streamUrl: string };

    const stream = await fetch(result.streamUrl, { headers: { Origin: "http://127.0.0.1:5173" } });
    expect(stream.status).toBe(200);
    const frames = await stream.text();
    expect(frames).toContain("event: token");
    expect(frames).toContain("event: message_done");

    const messages = await (await fetch(`${started.baseUrl}/api/chats/${chat.id}/messages`)).json() as Array<{ role: string; content: string }>;
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "这是谁？" }),
      expect.objectContaining({ role: "assistant", content: "我是芳乃，收到图片了。" }),
    ]));
  });
});
