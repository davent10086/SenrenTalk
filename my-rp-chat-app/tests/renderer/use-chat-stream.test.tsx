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
});
