// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GroupChatCreatePage } from "../../src/renderer/pages/GroupChatCreatePage";
import { GroupChatPage } from "../../src/renderer/pages/GroupChatPage";

const createGroupChat = vi.fn().mockResolvedValue(undefined);
const updateGroupChatRoom = vi.fn().mockResolvedValue(undefined);
const state = {
  activeChat: null as null | {
    id: string;
    participants: string[];
    roomConfig: { mode: "single_round" | "free_chat" | "host_mode"; hostRoleId: string | null; targetRoleId: string | null };
  },
};

vi.mock("../../src/renderer/context/BootstrapContext", () => ({
  useBootstrapContext: () => ({ characters: [
    { id: "芳乃", name: "芳乃", displayName: "芳乃", summary: "角色一", isPlayable: true },
    { id: "茉子", name: "茉子", displayName: "茉子", summary: "角色二", isPlayable: true },
  ] }),
}));
vi.mock("../../src/renderer/context/ViewContext", () => ({
  useViewContext: () => ({ ...state, createGroupChat, updateGroupChatRoom }),
}));
vi.mock("../../src/renderer/context/ChatContext", () => ({
  useChatContext: () => ({
    messages: [], drafts: {}, agentStatus: {}, activeRoleId: null, isStreaming: false,
    streamError: null, streamNotice: null, currentRound: 0, plannedSpeakers: [],
    skippedRoles: [], finishedReason: null, roomMode: null, targetRoleId: null,
    sendMessage: vi.fn(), updateGroupChatRoom, editMessageAndRegenerate: vi.fn(),
    stopGeneration: vi.fn(), refreshMessages: vi.fn(), retryAudio: vi.fn(),
    clearChat: vi.fn(), deleteChat: vi.fn(),
  }),
}));
vi.mock("../../src/renderer/components/ChatWorkspace", () => ({
  ChatWorkspace: ({ headerExtra, error }: { headerExtra: React.ReactNode; error: string | null }) => (
    <div>{headerExtra}{error ? <p>{error}</p> : null}</div>
  ),
}));

beforeEach(() => {
  createGroupChat.mockClear();
  updateGroupChatRoom.mockClear();
  state.activeChat = null;
});

describe("group chat mode controls", () => {
  it("creates free chat with two rounds and twice the participant count", () => {
    render(<GroupChatCreatePage />);
    fireEvent.click(screen.getByText("芳乃"));
    fireEvent.click(screen.getByText("茉子"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "free_chat" } });
    fireEvent.click(screen.getByRole("button", { name: /创建群聊/ }));
    expect(createGroupChat).toHaveBeenCalledWith(["芳乃", "茉子"], expect.objectContaining({
      mode: "free_chat", maxRounds: 2, maxMessages: 4,
    }));
  });

  it("requires an explicit host before creating a host room", () => {
    render(<GroupChatCreatePage />);
    fireEvent.click(screen.getByText("芳乃"));
    fireEvent.click(screen.getByText("茉子"));
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "host_mode" } });
    expect((screen.getByRole("button", { name: /创建群聊/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "选择主持角色" }), { target: { value: "茉子" } });
    fireEvent.click(screen.getByRole("button", { name: /创建群聊/ }));
    expect(createGroupChat).toHaveBeenCalledWith(["芳乃", "茉子"], expect.objectContaining({
      mode: "host_mode", hostRoleId: "茉子",
    }));
  });

  it("waits for a host before switching an existing room to host mode", () => {
    state.activeChat = {
      id: "chat-1", participants: ["芳乃", "茉子"],
      roomConfig: { mode: "single_round", hostRoleId: null, targetRoleId: null },
    };
    render(<GroupChatPage />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "host_mode" } });
    expect(updateGroupChatRoom).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "选择主持角色" }), { target: { value: "芳乃" } });
    expect(updateGroupChatRoom).toHaveBeenCalledWith(expect.objectContaining({
      roomConfig: expect.objectContaining({ mode: "host_mode", hostRoleId: "芳乃" }),
    }));
  });

  it("writes mode-specific budgets when switching between free and single round", () => {
    state.activeChat = {
      id: "chat-2", participants: ["芳乃", "茉子"],
      roomConfig: { mode: "single_round", hostRoleId: null, targetRoleId: null },
    };
    const { rerender } = render(<GroupChatPage />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "free_chat" } });
    expect(updateGroupChatRoom).toHaveBeenCalledWith(expect.objectContaining({
      roomConfig: expect.objectContaining({ mode: "free_chat", maxRounds: 2, maxMessages: 4 }),
    }));
    state.activeChat.roomConfig.mode = "free_chat";
    rerender(<GroupChatPage />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "single_round" } });
    expect(updateGroupChatRoom).toHaveBeenCalledWith(expect.objectContaining({
      roomConfig: expect.objectContaining({ mode: "single_round", maxRounds: 1, maxMessages: 2 }),
    }));
  });
});
