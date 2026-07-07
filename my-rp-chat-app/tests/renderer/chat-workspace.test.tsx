// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "../../src/renderer/components/ChatWorkspace";

describe("ChatWorkspace", () => {
  it("shows interrupted notice after generation is cancelled", () => {
    render(
      <ChatWorkspace
        title="单聊"
        chat={null}
        messages={[]}
        drafts={{}}
        agentStatus={{}}
        activeRoleId={null}
        isStreaming={false}
        error={null}
        notice="已中断"
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("已中断")).toBeTruthy();
  });
});
