import { describe, expect, it, vi } from "vitest";
import { __internal } from "../src/backend/services/llm/llm-service";

describe("llm structured parser", () => {
  it("extracts incremental content from partial JSON", () => {
    const partial = "{\"content\":\"今天有点冷，你";
    expect(__internal.extractPartialJsonStringField(partial, "content")).toEqual({
      value: "今天有点冷，你",
      complete: false,
    });
  });

  it("decodes escaped characters in streamed content", () => {
    const partial = "{\"content\":\"第一行\\n\\\"测试\\\"\",\"speechTextJa\":\"";
    expect(__internal.extractPartialJsonStringField(partial, "content")).toEqual({
      value: "第一行\n\"测试\"",
      complete: true,
    });
  });

  it("parses fenced JSON response", () => {
    const raw = [
      "```json",
      "{\"content\":\"我会多穿一点。\",\"speechTextJa\":\"もう少し暖かくします。\"}",
      "```",
    ].join("\n");

    expect(__internal.parseStructuredResponse(raw)).toEqual({
      content: "我会多穿一点。",
      speechTextJa: "もう少し暖かくします。",
    });
  });
});

// ============ 修复后的 consolidateCoreMemory / extractEpisodicMemory 测试 ============
// 通过 mock OpenAI client 验证：
// 1. prompt 包含角色名、当前核心记忆、JSON 格式约束
// 2. 正则修复后能正确解析带 ```json 围栏的输出
// 3. 非法 JSON 输出时返回安全默认值

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };
    },
  };
});

describe("LlmService.extractEpisodicMemory (regex fix)", () => {
  it("strips ```json fences and parses embedded JSON correctly", async () => {
    // 修复前：正则使用 \\s（字面量反斜杠+s）无法匹配 ```json\n 前缀
    // 修复后：使用 \s 正确匹配空白符，能剥离 ```json 围栏
    const { LlmService } = await import("../src/backend/services/llm/llm-service");
    const service = new LlmService({
      llmApiKey: "test-key",
      llmBaseUrl: "http://localhost",
      llmModel: "test-model",
    } as never);

    const mockResponse = {
      choices: [
        {
          message: {
            content: '```json\n{"summary":"散步","emotion":"开心","importance":7,"keyPoints":["晴天"]}\n```',
          },
        },
      ],
    };
    (service as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create.mockResolvedValue(mockResponse);

    const result = await service.extractEpisodicMemory({
      characterName: "丛雨",
      userInput: "去散步吧",
      assistantOutput: "好的，走吧。",
    });

    expect(result.summary).toBe("散步");
    expect(result.emotion).toBe("开心");
    expect(result.importance).toBe(7);
    expect(result.keyPoints).toEqual(["晴天"]);
  });

  it("returns safe defaults when LLM output is not valid JSON", async () => {
    const { LlmService } = await import("../src/backend/services/llm/llm-service");
    const service = new LlmService({
      llmApiKey: "test-key",
      llmBaseUrl: "http://localhost",
      llmModel: "test-model",
    } as never);

    (service as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "这不是JSON" } }],
      });

    const result = await service.extractEpisodicMemory({
      characterName: "丛雨",
      userInput: "测试",
      assistantOutput: "回复内容",
    });

    // 降级：使用 assistantOutput 截取作为 summary
    expect(result.summary).toBe("回复内容");
    expect(result.emotion).toBe("平静");
    expect(result.importance).toBe(3);
    expect(result.keyPoints).toEqual([]);
  });
});

describe("LlmService.consolidateCoreMemory (prompt quality fix)", () => {
  it("system prompt includes characterName, currentCore and JSON format requirement", async () => {
    // 修复前：system prompt 仅 "关系分析师。"，未使用 characterName 和 currentCore
    // 修复后：prompt 包含角色名、当前核心记忆、JSON 格式模板
    const { LlmService } = await import("../src/backend/services/llm/llm-service");
    const service = new LlmService({
      llmApiKey: "test-key",
      llmBaseUrl: "http://localhost",
      llmModel: "test-model",
    } as never);

    const createMock = (service as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create;
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"userPreferences":["喜欢甜食"],"userTraits":["温柔"],"relationshipStage":"熟悉","relationshipNotes":[],"keyFacts":[]}',
          },
        },
      ],
    });

    await service.consolidateCoreMemory({
      characterName: "芳乃",
      currentCore: "已有核心记忆：用户喜欢猫",
      recentMemories: ["芳乃和用户讨论了猫", "用户给芳乃看了猫的照片"],
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0][0];
    const systemPrompt = callArgs.messages[0].content;

    // 验证 prompt 包含角色名
    expect(systemPrompt).toContain("芳乃");
    // 验证 prompt 包含当前核心记忆
    expect(systemPrompt).toContain("已有核心记忆");
    // 验证 prompt 包含 JSON 格式要求
    expect(systemPrompt).toContain("JSON");
    expect(systemPrompt).toContain("userPreferences");
    expect(systemPrompt).toContain("relationshipStage");
    // 验证 prompt 要求只输出 JSON
    expect(systemPrompt).toContain("只输出 JSON");
  });

  it("parses valid JSON response with all fields", async () => {
    const { LlmService } = await import("../src/backend/services/llm/llm-service");
    const service = new LlmService({
      llmApiKey: "test-key",
      llmBaseUrl: "http://localhost",
      llmModel: "test-model",
    } as never);

    (service as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: '```json\n{"userPreferences":["喜欢甜食","喜欢猫"],"userTraits":["温柔"],"relationshipStage":"亲密","relationshipNotes":["一起散步"],"keyFacts":["住在东京"]}\n```',
            },
          },
        ],
      });

    const result = await service.consolidateCoreMemory({
      characterName: "芳乃",
      currentCore: "无",
      recentMemories: ["记忆1"],
    });

    expect(result.userPreferences).toEqual(["喜欢甜食", "喜欢猫"]);
    expect(result.userTraits).toEqual(["温柔"]);
    expect(result.relationshipStage).toBe("亲密");
    expect(result.relationshipNotes).toEqual(["一起散步"]);
    expect(result.keyFacts).toEqual(["住在东京"]);
  });

  it("returns empty arrays for invalid JSON response", async () => {
    const { LlmService } = await import("../src/backend/services/llm/llm-service");
    const service = new LlmService({
      llmApiKey: "test-key",
      llmBaseUrl: "http://localhost",
      llmModel: "test-model",
    } as never);

    (service as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "无法解析的内容" } }],
      });

    const result = await service.consolidateCoreMemory({
      characterName: "芳乃",
      currentCore: "无",
      recentMemories: ["记忆1"],
    });

    expect(result.userPreferences).toEqual([]);
    expect(result.userTraits).toEqual([]);
    expect(result.relationshipStage).toBe("");
    expect(result.relationshipNotes).toEqual([]);
    expect(result.keyFacts).toEqual([]);
  });
});

// ============ 双模型切换测试 ============
// 验证 streamStructuredCompletion 在有图片时使用 llmVisionModel，无图片时使用 llmModel。
// 防止未来重构破坏多模态模型选择逻辑。

describe("LlmService.streamStructuredCompletion (dual model switching)", () => {
  it("uses llmVisionModel when images are provided", async () => {
    const { LlmService } = await import("../src/backend/services/llm/llm-service");
    const service = new LlmService({
      llmApiKey: "test-key",
      llmBaseUrl: "http://localhost",
      llmModel: "qwen-plus",
      llmVisionModel: "qwen-vl-plus",
    } as never);

    const createMock = (service as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create;
    // mock 流式返回：返回一个 async iterable
    createMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: '{"content":"看到图片","speechTextJa":"画像を見た"}' } }] };
      },
    });

    await service.streamStructuredCompletion({
      systemPrompt: "系统提示",
      userPrompt: "看图",
      images: [{ mimeType: "image/png", base64: "aGVsbG8=" }],
      onToken: () => {},
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.model).toBe("qwen-vl-plus");
  });

  it("uses llmModel when no images are provided", async () => {
    const { LlmService } = await import("../src/backend/services/llm/llm-service");
    const service = new LlmService({
      llmApiKey: "test-key",
      llmBaseUrl: "http://localhost",
      llmModel: "qwen-plus",
      llmVisionModel: "qwen-vl-plus",
    } as never);

    const createMock = (service as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create;
    createMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: '{"content":"纯文本回复","speechTextJa":"テキストのみ"}' } }] };
      },
    });

    await service.streamStructuredCompletion({
      systemPrompt: "系统提示",
      userPrompt: "你好",
      onToken: () => {},
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.model).toBe("qwen-plus");
  });
});
