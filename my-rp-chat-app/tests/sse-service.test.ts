import { afterEach, describe, expect, it } from "vitest";
import { SseService } from "../src/backend/services/stream/sse-service";

let service: SseService | undefined;

afterEach(async () => {
  await service?.stop();
  service = undefined;
});

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
});
