// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "../../src/renderer/components/ChatWorkspace";
import type { ChatRecord } from "../../src/common/types";

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

  it("labels dynamically updated speakers as candidates", () => {
    const chat = {
      id: "group-1", title: "群聊", mode: "group", participants: ["芳乃", "茉子"],
      createdAt: 0, updatedAt: 0, mentionTarget: null,
    } as ChatRecord;
    render(<ChatWorkspace
      title="群聊" chat={chat} messages={[]} drafts={{}} agentStatus={{}}
      activeRoleId={null} isStreaming={false} error={null}
      plannedSpeakers={["茉子", "芳乃"]} onSend={vi.fn().mockResolvedValue(undefined)}
    />);
    expect(screen.getByText("候选发言：茉子 / 芳乃")).toBeTruthy();
  });
});
