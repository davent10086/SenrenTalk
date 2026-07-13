import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { MediaManager } from "../src/backend/media-manager";
import type { AppConfig } from "../src/backend/config";
import { cleanupTempDirs, createTempDir } from "./helpers/temp-dir";

afterEach(async () => {
  await cleanupTempDirs();
});

function makeConfig(root: string): AppConfig {
  return {
    appName: "test",
    appRoot: root,
    workspaceRoot: root,
    datasetDir: path.join(root, "dataset"),
    sqlitePath: path.join(root, "db.sqlite"),
    mediaDir: path.join(root, "media"),
    embeddingDimensions: 1024,
    ollamaHost: "http://127.0.0.1:11434",
    ollamaModelName: "bge-m3:latest",
    llmBaseUrl: "http://127.0.0.1:8000",
    llmModel: "test-model",
    llmVisionModel: "test-vision-model",
    esNode: "https://127.0.0.1:9200/",
    esEnabled: false,
    esUsername: "elastic",
    esPassword: "",
    esDialogueIndex: "dialogues",
    esMemoryIndex: "memories",
    esRejectUnauthorized: true,
    topK: 8,
    ttsProvider: "disabled",
    ttsCharacterVoiceMap: {},
    langsmithTracing: false,
    langsmithProject: "test",
    langsmithEndpoint: "https://api.smith.langchain.com",
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("MediaManager security", () => {
  it("rejects attachment ids that would escape the chat media directory", async () => {
    const root = createTempDir("media-manager-");
    const manager = new MediaManager(makeConfig(root));
    const source = path.join(root, "upload.png");
    await fs.writeFile(source, "image");

    await expect(
      manager.persistAttachments("chat-1", "message-1", [
        {
          id: "../outside",
          kind: "image",
          originalName: "photo.png",
          mimeType: "image/png",
          size: 5,
          absolutePath: source,
        },
      ]),
    ).rejects.toThrow(/Invalid attachmentId/);

    await expect(exists(path.join(root, "media", "outside.png"))).resolves.toBe(false);
  });

  it("stores safe attachments only under media/images/<chatId>", async () => {
    const root = createTempDir("media-manager-");
    const manager = new MediaManager(makeConfig(root));
    const source = path.join(root, "upload.png");
    await fs.writeFile(source, "image");

    const [attachment] = await manager.persistAttachments("chat-1", "message-1", [
      {
        id: "attachment-1",
        kind: "image",
        originalName: "photo.png",
        mimeType: "image/png",
        size: 5,
        absolutePath: source,
      },
    ]);

    expect(attachment.relativePath).toBe("images/chat-1/message-1-attachment-1.png");
    await expect(exists(path.join(root, "media", attachment.relativePath))).resolves.toBe(true);
  });

  it("rejects traversal chat ids before recursive cleanup", async () => {
    const root = createTempDir("media-manager-");
    const manager = new MediaManager(makeConfig(root));
    const sentinel = path.join(root, "sentinel.txt");
    await fs.writeFile(sentinel, "keep");

    await expect(manager.cleanupChatMedia("../sentinel")).rejects.toThrow(/Invalid chatId/);
    await expect(exists(sentinel)).resolves.toBe(true);
  });

  it("does not resolve stored relative paths outside the media directory", () => {
    const root = createTempDir("media-manager-");
    const manager = new MediaManager(makeConfig(root));

    expect(() => manager.resolveMediaPath("../secret.txt")).toThrow(/escapes/);
  });
});
