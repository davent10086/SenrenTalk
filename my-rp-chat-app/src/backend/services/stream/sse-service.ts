import express, { type Request, type Response } from "express";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "../../../common/types";
import { createCorsMiddleware } from "../../../server/middleware/cors";

/**
 * 表示一个活跃的流会话，用于管理 SSE（Server-Sent Events）连接。
 *
 * 每个会话由唯一的 streamId 标识，并通过 token 进行鉴权。
 * 会话可以持有多个客户端连接（responses），每个连接独立推送事件。
 * backlog 用于保存会话期间所有已发布的事件，供新加入的客户端消费。
 */
interface StreamSession {
  id: string;
  token: string;
  responses: Set<Response>;
  backlog: StreamEvent[];
  closed: boolean;
}

/**
 * 从请求中提取 Token，优先级：
 * 1. Authorization: Bearer <token> 头（推荐方式）
 * 2. ?token=<value> URL 查询参数（兼容 EventSource API 限制）
 */
function extractToken(request: Request): string | undefined {
  // 优先检查 Authorization 头
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  // 回退到查询参数（EventSource 原生 API 不支持自定义头）
  const tokenParam = request.query.token;
  if (typeof tokenParam === "string") {
    return tokenParam;
  }
  if (Array.isArray(tokenParam) && typeof tokenParam[0] === "string") {
    return tokenParam[0];
  }

  return undefined;
}

/**
 * SSE 流服务，提供内嵌的 HTTP 服务器用于 Server-Sent Events 推送。
 *
 * 核心职责：
 * - 创建和管理流会话（StreamSession），每个会话通过随机生成的 token 鉴权；
 * - 将业务层产生的 {@link StreamEvent} 广播给所有已连接的 SSE 客户端；
 * - 维护事件积压（backlog），确保新客户端可以消费历史事件；
 * - 支持多客户端同时订阅同一条流。
 *
 * 安全特性：优先通过 `Authorization: Bearer <token>` 头进行鉴权，
 * 同时兼容原生 EventSource API 的 `?token=` 查询参数方式。
 */
export class SseService {
  private readonly app = express();
  private server?: Server;
  private port = 0;
  private readonly sessions = new Map<string, StreamSession>();
  /** 性能计数：记录 token 通过 URL 传递的次数 */
  private urlTokenFallbackCount = 0;

  /**
   * 创建 SseService 实例。
   *
   * 初始化 Express 应用并注册以下路由：
   * - `GET /health` — 健康检查端点
   * - `GET /streams/:streamId` — SSE 流连接端点，由 {@link handleStream} 处理
   *
   * 所有路由统一使用共享的 CORS 中间件以允许跨域连接。
   */
  constructor() {
    // 使用共享的 CORS 中间件
    this.app.use(createCorsMiddleware(true));

    this.app.get("/health", (_request, response) => {
      response.json({ ok: true });
    });

    this.app.get("/streams/:streamId", (request, response) => {
      this.handleStream(request, response);
    });
  }

  /**
   * 启动内部 HTTP 服务器。
   *
   * 在 `127.0.0.1` 的随机可用端口（port 0）上监听。
   * 如果服务器已在运行，则此方法无操作（幂等）。
   * 启动完成后可通过 {@link baseUrl} 获取服务器的实际地址。
   */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server = this.app.listen(0, "127.0.0.1", () => {
        const address = this.server?.address() as AddressInfo | null;
        this.port = address?.port ?? 0;
        resolve();
      });
    });
  }

  /**
   * 停止内部 HTTP 服务器并清理所有活跃会话。
   *
   * 清理流程：
   * 1. 将所有会话标记为已关闭
   * 2. 终止每个会话中所有 SSE 连接（response.end()）
   * 3. 清空积压事件和会话映射
   * 4. 关闭 HTTP 服务器
   *
   * 如果服务器未在运行，则此方法无操作（幂等）。
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    this.sessions.forEach((session) => {
      session.closed = true;
      session.responses.forEach((response) => response.end());
      session.responses.clear();
      session.backlog.length = 0;
    });
    this.sessions.clear();
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.server = undefined;
    this.port = 0;
  }

  /**
   * 获取内部 HTTP 服务器的 base URL。
   *
   * 格式为 `http://127.0.0.1:<port>`，其中端口由操作系统在服务器启动时动态分配。
   * 应当在调用 {@link start} 之后访问此属性。
   */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * 创建一个新的流会话。
   *
   * 生成流程：
   * 1. 使用 `randomUUID()` 生成唯一的 streamId 和 token；
   * 2. 将新会话（包含空响应集和空积压）存入内部 Map；
   * 3. 返回包含 streamId 和完整 streamUrl 的对象。
   *
   * **Token 生成说明：**
   * token 是通过 `crypto.randomUUID()` 生成的随机 UUID v4，不可预测，
   * 确保只有持有该 token 的客户端才能连接到此流。
   *
   * 返回的 streamUrl 已经包含 `?token=<value>` 查询参数，
   * 直接传给前端的 `new EventSource(streamUrl)` 即可使用。
   *
   * @returns 包含 streamId 和带 token 的 streamUrl 的对象
   */
  createSession(): { streamId: string; streamUrl: string } {
    const streamId = randomUUID();
    const token = randomUUID();
    this.sessions.set(streamId, {
      id: streamId,
      token,
      responses: new Set<Response>(),
      backlog: [],
      closed: false,
    });

    // 返回带 Token 的 URL — 前端 EventSource API 需要通过 URL 参数传递
    const streamUrl = `${this.baseUrl}/streams/${streamId}?token=${token}`;
    return { streamId, streamUrl };
  }

  /**
   * 向指定流会话发布一个事件。
   *
   * **事件分发流程：**
   * 1. 根据 `event.streamId` 查找对应的会话；
   * 2. 如果会话不存在或已关闭，则静默忽略；
   * 3. 将事件追加到会话的 backlog 中（用于新客户端追赶）；
   * 4. 将事件序列化为 SSE 格式（`event: <type>\ndata: <json>\n\n`），
   *    写入该会话下所有已注册的响应对象。
   *
   * 每个事件类型由 {@link StreamEvent.type} 决定，
   * 相同 type 的事件在客户端作为同一 SSE `event:` 类型处理。
   *
   * @param event 要发布的流事件，必须包含 streamId 和 type
   */
  publish(event: StreamEvent): void {
    const session = this.sessions.get(event.streamId);
    if (!session || session.closed) {
      return;
    }
    session.backlog.push(event);
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    session.responses.forEach((response) => response.write(payload));
  }

  /**
   * 关闭指定的流会话。
   *
   * 关闭操作：
   * 1. 将目标会话标记为 `closed`；
   * 2. 终止该会话下所有活跃的 SSE 连接；
   * 3. 清空响应集和积压事件；
   * 4. 从会话映射中删除该会话。
   *
   * 如果会话不存在，则静默忽略。
   *
   * @param streamId 要关闭的流会话 ID
   */
  close(streamId: string): void {
    const session = this.sessions.get(streamId);
    if (!session) {
      return;
    }
    session.closed = true;
    session.responses.forEach((response) => response.end());
    session.responses.clear();
    session.backlog.length = 0;
    this.sessions.delete(streamId);
  }

  /**
   * 处理客户端 SSE 连接请求（Express 路由处理器）。
   *
   * **鉴权流程：**
   * 1. 从请求中提取 streamId（URL 路径参数）和 token（通过 {@link extractToken}）；
   * 2. 校验会话是否存在、是否未关闭、token 是否匹配；
   * 3. 鉴权失败时返回 `404 { message: "stream not found" }`。
   *
   * **连接建立后：**
   * - 设置 SSE 响应头（`Content-Type: text/event-stream` 等）；
   * - 发送 `: connected` 注释帧以建立连接；
   * - 将当前响应对象注册到会话的 responses 集合；
   * - **将 backlog 中的所有历史事件一次性发送给新客户端**，确保事件不丢失；
   * - 监听请求 `close` 事件，客户端断开时自动从 responses 集合中移除。
   *
   * 此方法仅供内部路由使用，不对外暴露。
   *
   * @param request Express 请求对象
   * @param response Express 响应对象
   */
  private handleStream(request: Request, response: Response): void {
    const streamId = Array.isArray(request.params.streamId)
      ? request.params.streamId[0]
      : request.params.streamId;
    const session = this.sessions.get(streamId);
    const token = extractToken(request);

    if (token && typeof request.query.token === "string") {
      this.urlTokenFallbackCount += 1;
      if (this.urlTokenFallbackCount % 100 === 1) {
        console.warn(
          `[SseService] Token 通过 URL 传递已发生 ${this.urlTokenFallbackCount} 次`,
          `（推荐客户端使用 Authorization: Bearer 头）`,
        );
      }
    }

    if (!session || session.closed || token !== session.token) {
      response.status(404).json({ message: "stream not found" });
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };

    response.writeHead(200, headers);

    response.write(": connected\n\n");
    session.responses.add(response);
    session.backlog.forEach((event) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    request.on("close", () => {
      session.responses.delete(response);
    });
  }
}

