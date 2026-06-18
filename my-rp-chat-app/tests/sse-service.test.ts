import { afterEach, describe, expect, it } from "vitest";
import { SseService } from "../src/backend/services/stream/sse-service";
import type { StreamEvent } from "../src/common/types";

let service: SseService | undefined;

afterEach(async () => {
  await service?.stop();
  service = undefined;
});

/** 解析单个 SSE 帧（event: type\ndata: json）为 StreamEvent，注释帧返回 null。 */
function parseSseFrame(frame: string): StreamEvent | null {
  let type = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) {
      type = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data = line.slice(6);
    }
  }
  if (type && data) {
    try {
      return JSON.parse(data) as StreamEvent;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 连接 SSE 流并收集事件。
 * - beforeConnect: 在发起连接前执行（用于预发布事件测试 backlog 回放）
 * - afterConnect: 在连接建立后执行（用于发布实时事件）
 * - waitMs: 连接后读取事件的持续时间（默认 300ms）
 */
async function collectSseEvents(
  streamUrl: string,
  options: {
    beforeConnect?: () => Promise<void>;
    afterConnect?: () => Promise<void>;
    waitMs?: number;
  } = {},
): Promise<StreamEvent[]> {
  await options.beforeConnect?.();

  const response = await fetch(streamUrl, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });

  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  await options.afterConnect?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: StreamEvent[] = [];
  const waitMs = options.waitMs ?? 300;
  const deadline = Date.now() + waitMs;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) events.push(parsed);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return events;
}

describe("SseService", () => {
  it("invalidates a stream URL after the session is closed", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();
    service.publish({
      type: "token",
      streamId: stream.streamId,
      roleId: "芳乃",
      token: "你好",
    });
    service.close(stream.streamId);

    const response = await fetch(stream.streamUrl, {
      headers: {
        Origin: "http://127.0.0.1:5173",
      },
    });

    expect(response.status).toBe(404);
  });

  it("rejects non-local origins even when the stream token is correct", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();

    const response = await fetch(stream.streamUrl, {
      headers: {
        Origin: "https://evil.example",
      },
    });

    expect(response.status).toBe(403);
  });

  it("publishes token events to connected client", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();

    const events = await collectSseEvents(stream.streamUrl, {
      afterConnect: async () => {
        service!.publish({
          type: "token",
          streamId: stream.streamId,
          roleId: "芳乃",
          token: "你好",
        });
      },
      waitMs: 200,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("token");
    if (events[0].type === "token") {
      expect(events[0].roleId).toBe("芳乃");
      expect(events[0].token).toBe("你好");
    }
  });

  it("publishes message_done event with full content", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();

    const events = await collectSseEvents(stream.streamUrl, {
      afterConnect: async () => {
        service!.publish({
          type: "message_done",
          streamId: stream.streamId,
          roleId: "丛雨",
          messageId: "msg-1",
          content: "本座回应",
        });
      },
      waitMs: 200,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_done");
    if (events[0].type === "message_done") {
      expect(events[0].content).toBe("本座回应");
      expect(events[0].messageId).toBe("msg-1");
    }
  });

  it("publishes error event with roleId", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();

    const events = await collectSseEvents(stream.streamUrl, {
      afterConnect: async () => {
        service!.publish({
          type: "error",
          streamId: stream.streamId,
          roleId: "茉子",
          message: "角色发言失败",
        });
      },
      waitMs: 200,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].roleId).toBe("茉子");
      expect(events[0].message).toBe("角色发言失败");
    }
  });

  it("rejects request without valid token (404)", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();

    // Missing token: strip ?token= from URL
    const urlWithoutToken = stream.streamUrl.split("?")[0];
    const response1 = await fetch(urlWithoutToken, {
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    expect(response1.status).toBe(404);

    // Wrong token
    const response2 = await fetch(`${urlWithoutToken}?token=wrong-token`, {
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    expect(response2.status).toBe(404);
  });

  it("supports backlog replay on late connect", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();

    // Publish 3 events BEFORE any client connects
    service.publish({
      type: "token",
      streamId: stream.streamId,
      roleId: "芳乃",
      token: "你",
    });
    service.publish({
      type: "token",
      streamId: stream.streamId,
      roleId: "芳乃",
      token: "好",
    });
    service.publish({
      type: "message_done",
      streamId: stream.streamId,
      roleId: "芳乃",
      messageId: "msg-1",
      content: "你好",
    });

    const events = await collectSseEvents(stream.streamUrl, {
      waitMs: 200,
    });

    // Late client should receive all 3 historical events from backlog
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("token");
    expect(events[1].type).toBe("token");
    expect(events[2].type).toBe("message_done");
    if (events[2].type === "message_done") {
      expect(events[2].content).toBe("你好");
    }
  });

  it("allows multiple clients on same streamId", async () => {
    service = new SseService();
    await service.start();

    const stream = service.createSession();

    // Start two concurrent collectors (don't await yet)
    const collector1 = collectSseEvents(stream.streamUrl, { waitMs: 300 });
    // Give first collector time to connect
    await new Promise((r) => setTimeout(r, 50));
    const collector2 = collectSseEvents(stream.streamUrl, { waitMs: 300 });
    // Give second collector time to connect
    await new Promise((r) => setTimeout(r, 50));

    // Publish event - both clients should receive it
    service.publish({
      type: "token",
      streamId: stream.streamId,
      roleId: "芳乃",
      token: "你好",
    });

    const [events1, events2] = await Promise.all([collector1, collector2]);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0].type).toBe("token");
    expect(events2[0].type).toBe("token");
  });
});
