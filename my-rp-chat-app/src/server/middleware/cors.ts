/**
 * CORS 中间件
 *
 * 将 CORS 校验逻辑从请求处理器中提取为独立中间件，
 * 同时服务于 Express 主服务器和 SSE 子服务器。
 */
import type { Request, Response, NextFunction } from "express";

/**
 * 判断请求来源是否在允许的白名单内。
 *
 * 安全策略：
 * - 仅允许 loopback 地址（127.0.0.1 / localhost）的 HTTP/HTTPS 请求
 * - 拒绝无 origin 的请求（文件协议、data URI 等）
 * - Electron 应用中允许的请求走 http://localhost:<port>，符合白名单
 */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Express CORS 中间件工厂。
 *
 * @param allowNullOrigin - 是否允许 `null` origin（用于 Electron file:// 开发）
 */
export function createCorsMiddleware(allowNullOrigin = false) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers.origin;

    if (allowNullOrigin && (!origin || origin === "null")) {
      // Electron 开发模式下允许 file:// 协议
      response.header("Access-Control-Allow-Origin", "*");
    } else if (origin && isOriginAllowed(origin)) {
      response.header("Access-Control-Allow-Origin", origin);
      response.header("Vary", "Origin");
    } else {
      response.status(403).json({ message: "origin not allowed" });
      return;
    }

    response.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  };
}
