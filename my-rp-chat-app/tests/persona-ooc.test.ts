import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../src/backend/db/database";
import { createSingleChatGraph } from "../src/backend/graph/chat-graphs";
import { CharacterService } from "../src/backend/services/characters/character-service";
import type { AppConfig } from "../src/backend/config";
import type { StructuredCompletionRequest } from "../src/backend/services/llm/llm-service";

/**
 * 角色人设 OOC 修正验证测试。
 *
 * 通过 CharacterService 加载真实的 character_constraints.json，
 * 运行单聊图，捕获系统提示词，验证：
 * 1. 修正后的人设字段出现在系统提示词中
 * 2. 旧的 OOC 字段不再出现
 * 3. LLM 模拟回复符合人设
 */

const datasetDir = path.resolve(__dirname, "../../索引数据");
const createdDirectories: string[] = [];

afterEach(() => {
  createdDirectories.forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  createdDirectories.length = 0;
});

/**
 * 加载真实角色数据并初始化 repository。
 */
async function setupRepositoryWithRealCharacters(): Promise<ChatRepository> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-chat-persona-"));
  createdDirectories.push(tempDir);

  const repository = new ChatRepository(path.join(tempDir, "test.sqlite"));
  repository.init();

  const config = { datasetDir } as AppConfig;
  const characterService = new CharacterService(config);
  const characters = await characterService.loadCharacters();
  repository.upsertCharacters(characters);

  return repository;
}

/**
 * 运行单聊图并捕获系统提示词与保存的回复。
 */
async function runSingleChat(
  repository: ChatRepository,
  roleId: string,
  userMessage: string,
  mockResponseFn: (systemPrompt: string) => { content: string; speechTextJa: string; raw: string },
): Promise<{ systemPrompt: string; savedContent: string }> {
  const chat = repository.createChat("single", [roleId], "人设测试");
  repository.appendMessage({ chatId: chat.id, role: "user", content: userMessage });

  let capturedSystemPrompt = "";

  const deps = {
    repository,
    characterService: {} as never,
    elasticsearchService: {
      hybridSearch: vi.fn().mockResolvedValue([]),
    } as never,
    llmService: {
      streamStructuredCompletion: vi.fn().mockImplementation(
        async ({ systemPrompt, onToken }: StructuredCompletionRequest) => {
          capturedSystemPrompt = systemPrompt;
          const response = mockResponseFn(systemPrompt);
          if (response.content) {
            await onToken(response.content);
          }
          return response;
        },
      ),
    } as never,
    memoryService: {
      recall: vi.fn().mockResolvedValue([]),
      getSummary: vi.fn().mockReturnValue(undefined),
      getCoreMemory: vi.fn().mockReturnValue(null),
      extractAndPersist: vi.fn().mockResolvedValue(null),
      consolidateCoreMemory: vi.fn().mockResolvedValue(null),
    } as never,
    sseService: {
      publish: vi.fn(),
    } as never,
  };

  const graph = createSingleChatGraph(deps);
  await graph.invoke({
    chatId: chat.id,
    streamId: "stream-test",
    mode: "single" as const,
    participants: [roleId],
    currentRoleId: roleId,
    messages: repository.listMessages(chat.id),
    retrievedDocs: [],
    memories: [],
    summary: undefined,
    prompt: "",
    output: "",
    speechTextJa: "",
    retryCount: 0,
    skip: false,
  });

  const messages = repository.listMessages(chat.id);
  const assistantMsg = messages.find((m) => m.role === "assistant");
  return {
    systemPrompt: capturedSystemPrompt,
    savedContent: assistantMsg?.content ?? "",
  };
}

describe("角色人设 OOC 修正验证 - 对话模拟", () => {
  describe("茉子 - 忍者身份与调皮性格", () => {
    it("被问到身份时，系统提示词包含忍者设定且不含天然呆", async () => {
      const repository = await setupRepositoryWithRealCharacters();

      const { systemPrompt, savedContent } = await runSingleChat(
        repository,
        "茉子",
        "茉子，能介绍一下你自己吗？",
        (sp) => {
          // 模拟 LLM 根据系统提示词生成符合人设的回复
          if (sp.includes("忍者")) {
            return {
              content: "常陆家世世代代，都以忍者的身份在暗处守护着巫女大人",
              speechTextJa: "",
              raw: "{}",
            };
          }
          return { content: "我是做家务的侍从", speechTextJa: "", raw: "{}" };
        },
      );

      // ✅ 修正后的人设字段出现在系统提示词中
      expect(systemPrompt).toContain("忍者");
      expect(systemPrompt).toContain("爱捉弄人");
      expect(systemPrompt).toContain("恶作剧");

      // ❌ 旧的 OOC 字段不再出现
      expect(systemPrompt).not.toContain("天然呆");
      expect(systemPrompt).not.toContain("迷糊");

      // 保存的回复符合人设
      expect(savedContent).toContain("忍者");
      expect(savedContent).not.toContain("侍从");

      repository.close();
    });

    it("被问到爱好时，系统提示词体现调皮而非天然呆", async () => {
      const repository = await setupRepositoryWithRealCharacters();

      const { systemPrompt } = await runSingleChat(
        repository,
        "茉子",
        "茉子，你平时有什么爱好？",
        () => ({
          content: "我喜欢捉弄人，偶尔搞点恶作剧~",
          speechTextJa: "",
          raw: "{}",
        }),
      );

      expect(systemPrompt).toContain("调皮");
      expect(systemPrompt).not.toContain("天然呆");
      expect(systemPrompt).not.toContain("迷糊");

      repository.close();
    });
  });

  describe("芳乃 - 甜食控与孩子气一面", () => {
    it("被问到甜食时，系统提示词包含甜食控设定", async () => {
      const repository = await setupRepositoryWithRealCharacters();

      const { systemPrompt, savedContent } = await runSingleChat(
        repository,
        "芳乃",
        "芳乃，你觉得鸡蛋烧应该放糖吗？",
        (sp) => {
          if (sp.includes("甜食控")) {
            return {
              content: "不放糖简直是歪门邪道啊！鸡蛋烧当然要放糖！",
              speechTextJa: "",
              raw: "{}",
            };
          }
          return { content: "随便都可以", speechTextJa: "", raw: "{}" };
        },
      );

      // ✅ 修正后的人设字段出现在系统提示词中
      expect(systemPrompt).toContain("甜食控");
      expect(systemPrompt).toContain("不放糖简直是歪门邪道");
      expect(systemPrompt).toContain("孩子气");

      // ❌ 旧的 OOC 字段不再出现
      expect(systemPrompt).not.toContain("端庄稳重");

      // 保存的回复符合人设
      expect(savedContent).toContain("歪门邪道");

      repository.close();
    });

    it("系统提示词包含不擅长早起设定", async () => {
      const repository = await setupRepositoryWithRealCharacters();

      const { systemPrompt } = await runSingleChat(
        repository,
        "芳乃",
        "芳乃，你早上起得来吗？",
        () => ({
          content: "嗯……早上有点困难呢",
          speechTextJa: "",
          raw: "{}",
        }),
      );

      expect(systemPrompt).toContain("不擅长早起");

      repository.close();
    });
  });

  describe("丛雨 - 元气开朗与怕幽灵", () => {
    it("被提到幽灵时，系统提示词包含怕幽灵设定且不含外表高傲", async () => {
      const repository = await setupRepositoryWithRealCharacters();

      const { systemPrompt, savedContent } = await runSingleChat(
        repository,
        "丛雨",
        "丛雨，你是幽灵吗？",
        (sp) => {
          if (sp.includes("怕幽灵")) {
            return {
              content: "本座才不是幽灵！不要把幽灵和本座相提并论！",
              speechTextJa: "",
              raw: "{}",
            };
          }
          return { content: "是的，我是幽灵", speechTextJa: "", raw: "{}" };
        },
      );

      // ✅ 修正后的人设字段出现在系统提示词中
      expect(systemPrompt).toContain("怕幽灵");
      expect(systemPrompt).toContain("元气开朗");
      expect(systemPrompt).toContain("容易吃醋");

      // ❌ 旧的 OOC 字段不再出现
      expect(systemPrompt).not.toContain("外表高傲");
      expect(systemPrompt).not.toContain("怕寂寞");

      // 保存的回复使用"本座"自称且否认是幽灵
      expect(savedContent).toContain("本座");
      expect(savedContent).toContain("不是幽灵");

      repository.close();
    });

    it("系统提示词包含吃醋设定", async () => {
      const repository = await setupRepositoryWithRealCharacters();

      const { systemPrompt } = await runSingleChat(
        repository,
        "丛雨",
        "丛雨，我今天和芳乃一起逛街了哦",
        () => ({
          content: "主人你明明可以和本座一起去的……哼",
          speechTextJa: "",
          raw: "{}",
        }),
      );

      expect(systemPrompt).toContain("吃醋");
      expect(systemPrompt).not.toContain("怕寂寞");

      repository.close();
    });
  });
});
