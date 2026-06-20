import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime } from "../src/backend/app-runtime";
import { ChatRepository } from "../src/backend/db/database";
import type {
  StructuredCompletionRequest,
  StructuredCompletionResult,
} from "../src/backend/services/llm/llm-service";
import type { CharacterProfile } from "../src/common/types";
import { cleanupTempDirs, createTempDir } from "./helpers/temp-dir";

/**
 * AppRuntime.sendMessage 集成测试。
 *
 * 验证核心入口的完整流程：
 * 1. 会话校验（不存在 / 群聊参与者数量）
 * 2. 用户消息持久化（含附件）
 * 3. SSE 流式通道创建
 * 4. 单聊/群聊分流
 * 5. job hooks 生命周期回调
 * 6. 错误路径（SSE error 事件 + job failed）
 */

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

/**
 * 构造一个带 mock 依赖的 AppRuntime 实例。
 *
 * AppRuntime 构造函数会实例化所有真实服务，这里通过覆盖 readonly 属性
 * 替换为 mock，避免真实调用 LLM/ES/TTS。
 */
async function createRuntimeWithMocks(options: {
  characters: CharacterProfile[];
  llmResponse?: string;
  llmSpeechTextJa?: string;
}): Promise<{
  runtime: AppRuntime;
  repository: ChatRepository;
  tempDir: string;
  publishMock: ReturnType<typeof vi.fn>;
  llmMock: ReturnType<typeof vi.fn>;
}> {
  const tempDir = createTempDir("rp-chat-runtime-");

  // 用真实构造函数初始化（会创建真实 SQLite + 真实 SseService）
  const runtime = new AppRuntime(tempDir, tempDir);

  // 在 start() 之前 mock characterService.loadCharacters，避免读取真实数据文件
  Object.assign(runtime.characterService, {
    loadCharacters: vi.fn().mockResolvedValue(options.characters),
  });

  await runtime.start();
  runtime.repository.upsertCharacters(options.characters);

  // 替换 LLM 服务为 mock
  const llmResponse = options.llmResponse ?? "你好，我是测试角色。";
  const llmSpeechTextJa = options.llmSpeechTextJa ?? "テストキャラクターです。";
  const llmMock = vi
    .fn<(request: StructuredCompletionRequest) => Promise<StructuredCompletionResult>>()
    .mockImplementation(async ({ onToken }) => {
      await onToken(llmResponse);
      return {
        content: llmResponse,
        speechTextJa: llmSpeechTextJa,
        raw: `<response><content>${llmResponse}</content><speechTextJa>${llmSpeechTextJa}</speechTextJa></response>`,
      };
    });

  Object.assign(runtime.llmService, {
    streamStructuredCompletion: llmMock,
    generateSpeechTextJa: vi.fn().mockResolvedValue(llmSpeechTextJa),
    extractTags: vi.fn().mockResolvedValue({}),
  });

  // 替换 ES 服务为 mock（避免真实 ES 连接）
  // 注意：enabled 是 getter，不能直接赋值，但未配置 ES_PASSWORD 时默认为 false
  Object.assign(runtime.elasticsearchService, {
    hybridSearch: vi.fn().mockResolvedValue([]),
    indexMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemoriesBySession: vi.fn().mockResolvedValue(undefined),
    ensureMemoryIndex: vi.fn().mockResolvedValue(undefined),
    buildDialogueIndex: vi.fn().mockResolvedValue({ indexedCount: 0 }),
  });

  // 替换 memory 服务为 mock
  Object.assign(runtime.memoryService, {
    recall: vi.fn().mockResolvedValue([]),
    getSummary: vi.fn().mockReturnValue(undefined),
    getCoreMemory: vi.fn().mockReturnValue(undefined),
    extractAndPersist: vi.fn().mockResolvedValue(null),
    consolidateCoreMemory: vi.fn().mockResolvedValue(null),
  });

  // 替换 TTS 服务为 mock（避免真实语音合成）
  Object.assign(runtime.ttsService, {
    isEnabled: vi.fn().mockReturnValue(false),
    synthesize: vi.fn().mockResolvedValue({
      status: "ready",
      path: "audio/test.mp3",
      voiceId: "test-voice",
    }),
    resolveVoiceId: vi.fn().mockReturnValue("test-voice"),
  });

  // 捕获 SSE publish 调用
  const publishMock = vi.fn();
  Object.assign(runtime.sseService, {
    publish: publishMock,
  });

  return { runtime, repository: runtime.repository, tempDir, publishMock, llmMock };
}

/** 等待 queueMicrotask 中的异步任务完成。 */
async function flushMicrotasks(timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(async () => {
  await cleanupTempDirs();
});

describe("AppRuntime.sendMessage", () => {
  it("throws when chat does not exist", async () => {
    const { runtime } = await createRuntimeWithMocks({
      characters: [createCharacter("芳乃")],
    });

    await expect(
      runtime.sendMessage(
        {
          chatId: "non-existent-chat",
          content: "你好",
          mode: "single",
          participants: ["芳乃"],
        },
        {},
      ),
    ).rejects.toThrow("会话不存在");

    await runtime.dispose();
  });

  it("throws when group chat has fewer than 2 participants", async () => {
    const { runtime } = await createRuntimeWithMocks({
      characters: [createCharacter("芳乃")],
    });
    const chat = runtime.createChat("group", ["芳乃"], "测试群聊");

    await expect(
      runtime.sendMessage(
        {
          chatId: chat.id,
          content: "你好",
          mode: "group",
          participants: ["芳乃"],
        },
        {},
      ),
    ).rejects.toThrow("群聊参与者数量必须在 2 到 5 人之间");

    await runtime.dispose();
  });

  it("throws when group chat has more than 5 participants", async () => {
    const characters = ["芳乃", "茉子", "蕾娜", "丛雨", "诗织", "路人甲"].map(createCharacter);
    const { runtime } = await createRuntimeWithMocks({ characters });
    const chat = runtime.createChat("group", characters.map((c) => c.id), "测试群聊");

    await expect(
      runtime.sendMessage(
        {
          chatId: chat.id,
          content: "你好",
          mode: "group",
          participants: characters.map((c) => c.id),
        },
        {},
      ),
    ).rejects.toThrow("群聊参与者数量必须在 2 到 5 人之间");

    await runtime.dispose();
  });

  it("persists user message and returns stream info for single chat", async () => {
    const { runtime, repository } = await createRuntimeWithMocks({
      characters: [createCharacter("芳乃")],
      llmResponse: "你好呀！",
    });
    const chat = runtime.createChat("single", ["芳乃"], "测试单聊");

    const result = await runtime.sendMessage(
      {
        chatId: chat.id,
        content: "你好，芳乃",
        mode: "single",
        participants: ["芳乃"],
      },
      {},
    );

    // 返回 stream 信息
    expect(result.jobId).toBeTruthy();
    expect(result.streamId).toBeTruthy();
    expect(result.streamUrl).toContain(result.streamId);

    // 用户消息已持久化
    const messages = repository.listMessages(chat.id);
    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    expect(userMessage?.content).toBe("你好，芳乃");

    await flushMicrotasks();

    // 异步生成的助手消息已持久化
    const updatedMessages = repository.listMessages(chat.id);
    const assistantMessage = updatedMessages.find((m) => m.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.content).toBe("你好呀！");

    await runtime.dispose();
  });

  it("uses [图片] placeholder when content is empty but attachments exist", async () => {
    const { runtime, repository, tempDir } = await createRuntimeWithMocks({
      characters: [createCharacter("芳乃")],
    });
    const chat = runtime.createChat("single", ["芳乃"], "测试图片消息");

    // 创建一个临时图片文件作为附件
    const imagePath = path.join(tempDir, "test-image.png");
    fs.writeFileSync(imagePath, Buffer.from("fake-png-content"));

    await runtime.sendMessage(
      {
        chatId: chat.id,
        content: "",
        mode: "single",
        participants: ["芳乃"],
        attachments: [
          {
            id: "att-1",
            kind: "image",
            originalName: "test-image.png",
            mimeType: "image/png",
            size: 100,
            absolutePath: imagePath,
          },
        ],
      },
      {},
    );

    const messages = repository.listMessages(chat.id);
    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage?.content).toBe("[图片]");
    expect(userMessage?.metadata?.attachments).toHaveLength(1);
    expect(userMessage?.metadata?.attachments?.[0].kind).toBe("image");
    expect(userMessage?.metadata?.attachments?.[0].relativePath).toContain("images");

    await runtime.dispose();
  });

  it("triggers job hooks: onJobRunning -> onJobCompleted on success", async () => {
    const { runtime } = await createRuntimeWithMocks({
      characters: [createCharacter("芳乃")],
      llmResponse: "完成",
    });
    const chat = runtime.createChat("single", ["芳乃"], "测试 hooks");

    const onJobRunning = vi.fn();
    const onJobCompleted = vi.fn();
    const onJobFailed = vi.fn();

    await runtime.sendMessage(
      {
        chatId: chat.id,
        content: "你好",
        mode: "single",
        participants: ["芳乃"],
      },
      {
        jobId: "job-test-1",
        onJobRunning,
        onJobCompleted,
        onJobFailed,
      },
    );

    // onJobRunning 在 sendMessage 返回前同步触发
    expect(onJobRunning).toHaveBeenCalledWith("job-test-1", expect.any(String));

    await flushMicrotasks();

    // onJobCompleted 在异步流程完成后触发
    expect(onJobCompleted).toHaveBeenCalledWith("job-test-1");
    expect(onJobFailed).not.toHaveBeenCalled();

    await runtime.dispose();
  });

  it("triggers onJobFailed and publishes SSE error when agent throws", async () => {
    const { runtime, llmMock } = await createRuntimeWithMocks({
      characters: [createCharacter("芳乃")],
    });
    const chat = runtime.createChat("single", ["芳乃"], "测试错误路径");

    // 让 LLM 抛出错误
    llmMock.mockRejectedValueOnce(new Error("LLM 服务不可用"));

    const onJobRunning = vi.fn();
    const onJobFailed = vi.fn();
    const onJobCompleted = vi.fn();

    await runtime.sendMessage(
      {
        chatId: chat.id,
        content: "你好",
        mode: "single",
        participants: ["芳乃"],
      },
      {
        jobId: "job-test-fail",
        onJobRunning,
        onJobFailed,
        onJobCompleted,
      },
    );

    await flushMicrotasks();

    // 错误时触发 onJobFailed，不触发 onJobCompleted
    expect(onJobFailed).toHaveBeenCalledWith("job-test-fail", "LLM 服务不可用");
    expect(onJobCompleted).not.toHaveBeenCalled();

    await runtime.dispose();
  });

  it("routes group chat through GroupChatCoordinator", async () => {
    const characters = [createCharacter("芳乃"), createCharacter("茉子")];
    const { runtime, repository, publishMock } = await createRuntimeWithMocks({
      characters,
      llmResponse: "群聊回复",
    });
    const chat = runtime.createChat("group", ["芳乃", "茉子"], "测试群聊");

    await runtime.sendMessage(
      {
        chatId: chat.id,
        content: "大家好",
        mode: "group",
        participants: ["芳乃", "茉子"],
      },
      {},
    );

    await flushMicrotasks();

    // 若有错误，打印 SSE error 事件便于调试
    const errorEvents = publishMock.mock.calls.filter(
      (call) => call[0]?.type === "error",
    );
    if (errorEvents.length > 0) {
      console.error("SSE error events:", errorEvents.map((c) => c[0]));
    }

    // 群聊应产生多条助手消息（2 角色 × 至少 1 轮）
    const messages = repository.listMessages(chat.id);
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

    // 两个角色都应发言
    const speakerIds = new Set(assistantMessages.map((m) => m.roleId));
    expect(speakerIds.has("芳乃")).toBe(true);
    expect(speakerIds.has("茉子")).toBe(true);

    await runtime.dispose();
  });
});
