import { describe, expect, it } from "vitest";
import { __internal } from "../src/backend/services/llm/deepseek-service";

describe("deepseek structured parser", () => {
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
