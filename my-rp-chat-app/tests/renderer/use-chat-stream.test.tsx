// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatStream } from "../../src/renderer/hooks/useChatStream";

vi.mock("../../src/renderer/api/client", () => ({
  sendMessage: vi.fn(),
  cancelJob: vi.fn().mockResolvedValue(undefined),
}));

class MockEventSource {
  static instance: MockEventSource | null = null;

  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: Event | MessageEvent<string>) => void>>();

  constructor(public readonly url: string) {
    MockEventSource.instance = this;
  }

  addEventListener(type: string, handler: (event: Event | MessageEvent<string>) => void) {
    const current = this.listeners.get(type) ?? [];
    current.push(handler);
    this.listeners.set(type, current);
  }

  close() {
    this.readyState = 2;
  }

  emit(type: string, payload?: unknown) {
    const handlers = this.listeners.get(type) ?? [];
    const event =
      payload === undefined
        ? ({ type } as Event)
        : ({ type, data: JSON.stringify(payload) } as MessageEvent<string>);
    handlers.forEach((handler) => handler(event));
  }

  emitNativeError() {
    this.readyState = 0;
    this.emit("error");
    this.readyState = 2;
    this.onerror?.({ type: "error" } as Event);
  }
}

describe("useChatStream", () => {
  afterEach(() => {
    MockEventSource.instance = null;
    vi.unstubAllGlobals();
  });

  it("ignores native EventSource close errors after message_done", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const onMessagesChanged = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useChatStream({ onMessagesChanged }));

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.runStreamRequest(async () => ({
        jobId: "job-1",
        streamId: "stream-1",
        streamUrl: "http://127.0.0.1:3001/streams/stream-1?token=test",
      }));
      await Promise.resolve();
    });

    const source = MockEventSource.instance;
    expect(source).toBeTruthy();

    await act(async () => {
      source?.emit("message_done", { roleId: "芳乃" });
      source?.emit("audio_ready", { roleId: "芳乃" });
      source?.emitNativeError();
      await pending;
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(onMessagesChanged).toHaveBeenCalled();
  });

  it("replaces retry drafts, ignores stale tokens, and accepts the same role in a later turn", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const onMessagesChanged = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useChatStream({ onMessagesChanged }));
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.runStreamRequest(async () => ({
        jobId: "job-2", streamId: "stream-2", streamUrl: "http://localhost/stream-2",
      }));
      await Promise.resolve();
    });
    const source = MockEventSource.instance!;
    act(() => {
      source.emit("draft_reset", { roleId: "芳乃", attemptId: "a1" });
      source.emit("token", { roleId: "芳乃", attemptId: "a1", token: "旧稿" });
    });
    expect(result.current.drafts["芳乃"]).toBe("旧稿");
    act(() => {
      source.emit("draft_reset", { roleId: "芳乃", attemptId: "a2" });
      source.emit("token", { roleId: "芳乃", attemptId: "a1", token: "迟到" });
      source.emit("token", { roleId: "芳乃", attemptId: "a2", token: "新稿" });
    });
    expect(result.current.drafts["芳乃"]).toBe("新稿");
    await act(async () => {
      source.emit("message_done", { roleId: "芳乃", attemptId: "a2" });
      await Promise.resolve();
    });
    expect(result.current.drafts["芳乃"]).toBeUndefined();
    act(() => {
      source.emit("draft_reset", { roleId: "芳乃", attemptId: "a3" });
      source.emit("token", { roleId: "芳乃", attemptId: "a3", token: "下一轮" });
    });
    expect(result.current.drafts["芳乃"]).toBe("下一轮");
    await act(async () => {
      source.emit("room_finished", { reason: "结束" });
      source.emitNativeError();
      await pending;
    });
    expect(result.current.drafts).toEqual({});
  });

  it("clears drafts after a role skip without closing the group stream", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const { result } = renderHook(() => useChatStream({ onMessagesChanged: vi.fn().mockResolvedValue(undefined) }));
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.runStreamRequest(async () => ({
        jobId: "job-3", streamId: "stream-3", streamUrl: "http://localhost/stream-3",
      }));
      await Promise.resolve();
    });
    const source = MockEventSource.instance!;
    act(() => {
      source.emit("draft_reset", { roleId: "芳乃", attemptId: "a1" });
      source.emit("token", { roleId: "芳乃", attemptId: "a1", token: "草稿" });
      source.emit("role_skipped", { roleId: "芳乃", reason: "similar_to_last", message: "跳过" });
      source.emit("token", { roleId: "芳乃", attemptId: "a1", token: "迟到" });
    });
    expect(result.current.drafts["芳乃"]).toBeUndefined();
    expect(result.current.isStreaming).toBe(true);
    act(() => {
      source.emit("draft_reset", { roleId: "茉子", attemptId: "a2" });
      source.emit("token", { roleId: "茉子", attemptId: "a2", token: "失败草稿" });
      source.emit("error", { roleId: "茉子", message: "角色失败" });
    });
    expect(result.current.drafts["茉子"]).toBeUndefined();
    expect(result.current.isStreaming).toBe(true);
    await act(async () => {
      source.emitNativeError();
      await pending;
    });
    expect(result.current.error).toBeNull();
  });

  it("clears the live draft when the user cancels", async () => {
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    const { result } = renderHook(() => useChatStream({ onMessagesChanged: vi.fn().mockResolvedValue(undefined) }));
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.runStreamRequest(async () => ({
        jobId: "job-4", streamId: "stream-4", streamUrl: "http://localhost/stream-4",
      }));
      await Promise.resolve();
    });
    act(() => {
      MockEventSource.instance?.emit("draft_reset", { roleId: "芳乃", attemptId: "a1" });
      MockEventSource.instance?.emit("token", { roleId: "芳乃", attemptId: "a1", token: "未完成" });
    });
    expect(result.current.drafts["芳乃"]).toBe("未完成");
    await act(async () => {
      await result.current.stopStream();
      await pending;
    });
    expect(result.current.drafts).toEqual({});
    expect(result.current.isStreaming).toBe(false);
  });
});
