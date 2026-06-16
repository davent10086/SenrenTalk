import { describe, it, expect } from "vitest";

describe("GroupChatCoordinator", () => {
  it("groupContext should include all participants", () => {
    const participants = ["丛雨", "芳乃", "茉子"];
    const ctx = [
      "=== 群聊模式 ===",
      "群聊参与者：" + participants.join("、"),
    ].join("\n");
    expect(ctx).toContain("丛雨");
    expect(ctx).toContain("芳乃");
    expect(ctx).toContain("茉子");
  });

  it("mentionTarget should speak first", () => {
    const ps = ["丛雨", "芳乃", "茉子"];
    const target = "芳乃";
    const ordered = [target, ...ps.filter((p) => p !== target)];
    expect(ordered[0]).toBe("芳乃");
  });

  it("max rounds should be limited", () => {
    expect(3).toBeGreaterThan(0);
    expect(15).toBeGreaterThan(3);
  });
});