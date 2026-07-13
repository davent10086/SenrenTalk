import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { createCorsMiddleware } from "../src/server/middleware/cors";
import { createApiTokenAuth } from "../src/server/middleware/security";

let server: Server | undefined;

afterEach(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server = undefined;
});

async function startApp(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server!.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("CORS and API token security", () => {
  it("rejects null origins by default", async () => {
    const app = express();
    app.use(createCorsMiddleware({ allowedOrigins: ["http://127.0.0.1:5173"] }));
    app.get("/ok", (_request, response) => response.json({ ok: true }));
    const baseUrl = await startApp(app);

    const response = await fetch(`${baseUrl}/ok`, {
      headers: { Origin: "null" },
    });

    expect(response.status).toBe(403);
  });

  it("rejects loopback origins that are not explicitly allowed", async () => {
    const app = express();
    app.use(createCorsMiddleware({ allowedOrigins: ["http://127.0.0.1:5173"] }));
    app.get("/ok", (_request, response) => response.json({ ok: true }));
    const baseUrl = await startApp(app);

    const response = await fetch(`${baseUrl}/ok`, {
      headers: { Origin: "http://127.0.0.1:9999" },
    });

    expect(response.status).toBe(403);
  });

  it("allows configured origins and PATCH preflight", async () => {
    const app = express();
    app.use(createCorsMiddleware({ allowedOrigins: ["http://127.0.0.1:5173"] }));
    app.patch("/ok", (_request, response) => response.json({ ok: true }));
    const baseUrl = await startApp(app);

    const response = await fetch(`${baseUrl}/ok`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "PATCH",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
  });

  it("requires a bearer token when LOCAL_API_TOKEN is configured", async () => {
    const app = express();
    app.use("/api", createApiTokenAuth("secret-token"));
    app.get("/api/ok", (_request, response) => response.json({ ok: true }));
    const baseUrl = await startApp(app);

    const missingToken = await fetch(`${baseUrl}/api/ok`);
    const validToken = await fetch(`${baseUrl}/api/ok`, {
      headers: { Authorization: "Bearer secret-token" },
    });

    expect(missingToken.status).toBe(401);
    expect(validToken.status).toBe(200);
  });
});
