import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppConfig } from "../src/backend/config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("createAppConfig", () => {
  it("enables elasticsearch TLS verification by default", () => {
    delete process.env.ES_TLS_REJECT_UNAUTHORIZED;

    const config = createAppConfig("F:\\app-root", path.join("F:\\user-data"));

    expect(config.esRejectUnauthorized).toBe(true);
  });

  it("allows opting out of TLS verification explicitly for local development", () => {
    process.env.ES_TLS_REJECT_UNAUTHORIZED = "false";

    const config = createAppConfig("F:\\app-root", path.join("F:\\user-data"));

    expect(config.esRejectUnauthorized).toBe(false);
  });
});
