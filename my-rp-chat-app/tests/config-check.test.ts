import { afterEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/server/config-check";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("validateAppConfig", () => {
  it("returns no warnings when all config is valid", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key";
    delete process.env.ES_TLS_REJECT_UNAUTHORIZED;
    process.env.ES_PASSWORD = "strong-password-123";
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;

    const warnings = validateAppConfig();

    expect(warnings).toHaveLength(0);
  });

  it("returns error when DEEPSEEK_API_KEY is missing", () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ES_TLS_REJECT_UNAUTHORIZED;
    delete process.env.ES_PASSWORD;
    delete process.env.LANGSMITH_TRACING;

    const warnings = validateAppConfig();

    const apiKeyWarning = warnings.find((w) => w.key === "DEEPSEEK_API_KEY");
    expect(apiKeyWarning).toBeDefined();
    expect(apiKeyWarning?.severity).toBe("error");
    expect(apiKeyWarning?.message).toContain("DeepSeek");
  });

  it("returns warning when ES_TLS_REJECT_UNAUTHORIZED is false", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key";
    process.env.ES_TLS_REJECT_UNAUTHORIZED = "false";
    process.env.ES_PASSWORD = "strong-password-123";
    delete process.env.LANGSMITH_TRACING;

    const warnings = validateAppConfig();

    const tlsWarning = warnings.find((w) => w.key === "ES_TLS_REJECT_UNAUTHORIZED");
    expect(tlsWarning).toBeDefined();
    expect(tlsWarning?.severity).toBe("warning");
    expect(tlsWarning?.message).toContain("TLS");
  });

  it("returns warning when LANGSMITH_TRACING is true but API key is missing", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key";
    delete process.env.ES_TLS_REJECT_UNAUTHORIZED;
    process.env.ES_PASSWORD = "strong-password-123";
    process.env.LANGSMITH_TRACING = "true";
    delete process.env.LANGSMITH_API_KEY;

    const warnings = validateAppConfig();

    const langsmithWarning = warnings.find((w) => w.key === "LANGSMITH_API_KEY");
    expect(langsmithWarning).toBeDefined();
    expect(langsmithWarning?.severity).toBe("warning");
    expect(langsmithWarning?.message).toContain("LangSmith");
  });
});
