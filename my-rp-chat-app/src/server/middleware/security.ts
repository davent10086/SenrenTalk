/**
 * 安全中间件
 *
 * 集中管理 Express 应用的安全性相关中间件：
 * - 速率限制（Rate Limiting）
 * - 文件上传校验
 * - 全局错误处理器（防信息泄露）
 */
import type { Request, Response, NextFunction } from "express";

// ──────────────────────────────────────────
//  速率限制
// ──────────────────────────────────────────

/**
 * 速率限制存储条目，记录单个 IP 在当前时间窗口内的请求计数。
 */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * 速率限制器配置参数。
 */
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 分钟窗口
  maxRequests: 30,     // 每分钟最多 30 次请求
};

/**
 * 简易内存速率限制中间件（生产环境可替换为 express-rate-limit）。
 *
 * @param config - 速率限制配置
 */
export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests } = { ...DEFAULT_RATE_LIMIT, ...config };
  const store = new Map<string, RateLimitEntry>();

  // 每分钟清理一次过期条目
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) {
        store.delete(key);
      }
    }
  }, 60_000).unref();

  return (request: Request, response: Response, next: NextFunction): void => {
    const key = request.ip ?? request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now >= entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (entry.count >= maxRequests) {
      response.status(429).json({
        message: "请求过于频繁，请稍后再试",
        retryAfterMs: entry.resetAt - now,
      });
      return;
    }

    entry.count += 1;
    next();
  };
}

// ──────────────────────────────────────────
//  文件上传校验
// ──────────────────────────────────────────

/**
 * 文件上传校验的限制配置。
 */
interface UploadLimits {
  maxFileSize: number;       // 单文件最大字节数
  maxFileCount: number;      // 单次最大文件数
  allowedMimeTypes: string[]; // 允许的 MIME 类型白名单
}

const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileSize: 5 * 1024 * 1024, // 5 MB
  maxFileCount: 6,
  allowedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "application/pdf",
  ],
};

/**
 * 文件校验产生的单条错误信息。
 */
interface FileValidationError {
  field: string;
  message: string;
}

/**
 * 校验上传文件的中间件。
 * 在每个文件进入 multer 之前拦截不符合条件的请求。
 */
export function createUploadValidator(limits: Partial<UploadLimits> = {}) {
  const { maxFileSize, maxFileCount, allowedMimeTypes } = {
    ...DEFAULT_UPLOAD_LIMITS,
    ...limits,
  };

  return (request: Request, _response: Response, next: NextFunction): void => {
    const errors: FileValidationError[] = [];
    const contentType = request.headers["content-type"] ?? "";

    // 非上传请求直接放行
    if (!contentType.includes("multipart/form-data")) {
      next();
      return;
    }

    const files = request.files as Express.Multer.File[] | undefined;

    if (files && files.length > maxFileCount) {
      errors.push({
        field: "files",
        message: `单次上传不能超过 ${maxFileCount} 个文件`,
      });
    }

    if (files) {
      for (const file of files) {
        if (file.size > maxFileSize) {
          errors.push({
            field: file.fieldname,
            message: `文件 "${file.originalname}" 超过大小限制 (${(maxFileSize / 1024 / 1024).toFixed(0)} MB)`,
          });
        }

        if (
          file.mimetype &&
          !allowedMimeTypes.includes(file.mimetype) &&
          allowedMimeTypes.length > 0
        ) {
          errors.push({
            field: file.fieldname,
            message: `文件类型 "${file.mimetype}" 不被允许`,
          });
        }
      }
    }

    if (errors.length > 0) {
      next(Object.assign(new Error(errors.map((e) => e.message).join("；")), { statusCode: 400 }));
      return;
    }

    next();
  };
}

// ──────────────────────────────────────────
//  全局错误处理器
// ──────────────────────────────────────────

/**
 * 创建全局 Express 错误处理中间件。
 *
 * 安全策略：
 * - 500 错误仅返回通用错误消息，防止内部信息泄露
 * - 4xx 错误透传原始消息，便于客户端调试
 * - 所有 5xx 错误同时输出到服务端日志
 *
 * @returns Express 错误处理中间件（4 参数签名）
 */
export function createErrorHandler() {
  return (
    error: Error & { statusCode?: number },
    _request: Request,
    response: Response,
    _next: NextFunction,
  ): void => {
    const statusCode = error.statusCode ?? 500;

    // 生产环境不暴露内部错误详情
    if (statusCode >= 500) {
      console.error("[ServerError]", error);
      response.status(statusCode).json({ message: "服务器内部错误" });
      return;
    }

    response.status(statusCode).json({ message: error.message });
  };
}
