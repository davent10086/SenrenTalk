﻿import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiService } from "./api-service";
import type { ChatMode, PendingAttachmentInput } from "../common/types";
import { createCorsMiddleware } from "./middleware/cors";
import {
  createRateLimiter,
  createUploadValidator,
  createErrorHandler,
} from "./middleware/security";
import { printConfigWarnings } from "./config-check";

// ──────────────────────────────────────────
//  工具函数
// ──────────────────────────────────────────

/**
 * 将 Express 请求参数统一转换为字符串。
 * 支持 query string 中的单值和数组形式，数组取第一个元素。
 *
 * @param value - 请求中的原始参数值，可能是字符串、字符串数组或 undefined
 * @returns 解析后的字符串，无效输入返回空字符串
 */
function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

/**
 * 解析请求中的参与者列表。
 * 支持三种输入形式：字符串数组、JSON 字符串数组、逗号分隔字符串。
 *
 * @param value - 参与者原始值，可能是字符串数组、JSON 字符串或逗号分隔字符串
 * @returns 解析后的参与者名称数组，无效输入返回空数组
 */
function parseParticipants(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry));
      }
    } catch {
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * 附件元数据的请求载荷结构。
 * 前端在上传文件时通过表单字段传递此 JSON 结构，
 * 服务端据此关联上传文件与附件描述信息。
 */
interface AttachmentMetaPayload {
  id: string;
  kind: PendingAttachmentInput["kind"];
  originalName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

/**
 * 解析请求中携带的附件元数据 JSON。
 * 前端通过 multipart/form-data 的附件元信息字段传递，
 * 服务端将其反序列化为结构化的附件元数据数组。
 *
 * @param value - 附件元信息的 JSON 字符串原始值
 * @returns 解析后的附件元数据数组，无效输入返回空数组
 */
function parseAttachmentMeta(value: unknown): AttachmentMetaPayload[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      id: String(record.id ?? ""),
      kind: (record.kind ?? "image") as PendingAttachmentInput["kind"],
      originalName: String(record.originalName ?? ""),
      mimeType: String(record.mimeType ?? "application/octet-stream"),
      size: Number(record.size ?? 0),
      width: typeof record.width === "number" ? record.width : undefined,
      height: typeof record.height === "number" ? record.height : undefined,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
    };
  });
}

// ──────────────────────────────────────────
//  应用启动
// ──────────────────────────────────────────

/**
 * 应用主入口函数。
 *
 * 执行流程：
 * 1. 检查启动配置并输出警告
 * 2. 初始化运行时（AppRuntime）和任务注册中心（JobRegistry）
 * 3. 挂载安全中间件（CORS、速率限制、上传校验）
 * 4. 注册 REST API 路由
 * 5. 托管前端静态资源（生产模式）
 * 6. 注册全局错误处理器
 * 7. 监听 SIGINT/SIGTERM 实现优雅关闭
 */
async function main(): Promise<void> {
  // 启动时检查环境变量
  printConfigWarnings();

  const appRoot = process.cwd();
  const userDataPath = process.env.WEB_DATA_DIR
    ? path.resolve(process.env.WEB_DATA_DIR)
    : path.join(appRoot, ".web-data");
  const uploadDir = path.join(userDataPath, "uploads");
  await fs.mkdir(uploadDir, { recursive: true });

  const api = new ApiService(appRoot, userDataPath);
  await api.start();

  const app = express();
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);

  // ── 中间件栈 ─────────────────────────
  // 顺序：CORS → 速率限制 → JSON 解析 → 上传校验

  app.use(createCorsMiddleware(
    /* allowNullOrigin */ true,  // Electron 开发环境需要文件协议支持
  ));
  app.use(createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 60,  // 每分钟 60 次，对 AI 聊天应用来说比较宽松
  }));
  app.use(express.json({ limit: "10mb" }));

  // multer 配置：限制文件大小和数量
  const upload = multer({
    dest: uploadDir,
    limits: {
      fileSize: 5 * 1024 * 1024,  // 5MB
      files: 6,
    },
  });

  // ── 静态资源 ─────────────────────────
  app.use("/media", express.static(api.runtime.config.mediaDir));

  // ── API 路由 ─────────────────────────

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/bootstrap", (_request, response) => {
    response.json(api.getBootstrapPayload());
  });

  app.get("/api/settings", (_request, response) => {
    response.json(api.getPublicSettings());
  });

  app.get("/api/chats", (_request, response) => {
    response.json(api.listChats());
  });

  app.get("/api/chats/:chatId/messages", (request, response) => {
    response.json(api.listMessages(readParam(request.params.chatId)));
  });

  app.post("/api/chats", (request, response) => {
    const body = request.body as { mode?: ChatMode; participants?: string[]; title?: string };
    const chat = api.createChat(body.mode ?? "single", body.participants ?? [], body.title);
    response.json(chat);
  });

  app.post("/api/chats/:chatId/clear", async (request, response) => {
    await api.clearMessages(readParam(request.params.chatId));
    response.json({ ok: true });
  });

  app.delete("/api/chats/:chatId", async (request, response) => {
    await api.deleteChat(readParam(request.params.chatId));
    response.json({ ok: true });
  });

  app.get("/api/jobs", (_request, response) => {
    response.json(api.listJobs());
  });

  app.post("/api/jobs/dialogue-index", async (_request, response) => {
    const runningJob = api.listJobs().find(
      (job) => job.type === "index_dialogues" && job.status === "running",
    );
    if (runningJob) {
      response.json(runningJob);
      return;
    }

    const job = await api.startDialogueIndexJob();
    response.json(job);
  });

  app.post("/api/messages/:messageId/tts-regenerate", async (request, response) => {
    const message = await api.regenerateMessageAudio(readParam(request.params.messageId));
    response.json(message);
  });

  // ── 文件上传路由 ─────────────────────
  // multer 先解析文件，再由 createUploadValidator 校验大小/数量/MIME 类型
  // 顺序不能颠倒：校验器依赖 request.files，而 multer 之前该字段为 undefined

  app.post(
    "/api/chats/:chatId/send",
    upload.array("files"),
    createUploadValidator(),
    async (request, response) => {
      const uploadedFiles = (request.files as Express.Multer.File[] | undefined) ?? [];
      try {
        const attachmentsMeta = parseAttachmentMeta(request.body.attachmentsMeta);
        const attachments: PendingAttachmentInput[] = attachmentsMeta.map((meta, index) => {
          const file = uploadedFiles[index];
          if (!file) {
            throw new Error(`附件 ${meta.originalName} 缺少上传文件`);
          }
          return {
            id: meta.id,
            kind: meta.kind,
            originalName: file.originalname || meta.originalName,
            mimeType: file.mimetype || meta.mimeType,
            size: file.size || meta.size,
            absolutePath: file.path,
            width: meta.width,
            height: meta.height,
            durationMs: meta.durationMs,
          };
        });

        const participants = parseParticipants(request.body.participants);
        const chatId = readParam(request.params.chatId);
        const result = await api.sendMessage({
          chatId,
          content: typeof request.body.content === "string" ? request.body.content : "",
          mode: (request.body.mode ?? "single") as ChatMode,
          participants,
          mentionTarget:
            typeof request.body.mentionTarget === "string"
              ? request.body.mentionTarget
              : null,
          attachments,
        });

        response.json(result);
      } finally {
        // 无论成功失败，清理临时上传文件
        await Promise.allSettled(
          uploadedFiles.map(async (file) => {
            await fs.rm(file.path, { force: true });
          }),
        );
      }
    },
  );

  // ── 前端静态资源（生产模式）────────────
  const distDir = path.join(appRoot, "dist");
  try {
    await fs.access(path.join(distDir, "index.html"));
    app.use(express.static(distDir));
    app.get("*", (_request, response) => {
      response.sendFile(path.join(distDir, "index.html"));
    });
  } catch {
    // 开发模式不需要构建产物
  }

  // ── 全局错误处理器 ────────────────────
  // 必须是最后一个 use()，且保持 4 个参数才能被 Express 识别为错误处理器
  app.use(createErrorHandler());

  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Web server ready at http://127.0.0.1:${port}`);
  });

  // ── 优雅关闭 ─────────────────────────
  const shutdown = async () => {
    await api.dispose();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

