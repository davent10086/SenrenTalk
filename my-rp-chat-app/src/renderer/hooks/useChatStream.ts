import { useMemo, useRef, useState } from "react";
import type { ChatMode } from "../../common/types";
import * as apiClient from "../api/client";
import type { PendingAttachmentDraft } from "../types";

/**
 * 发送消息的输入参数
 * 包含会话 ID、文本内容、聊天模式、参与者列表等必要字段
 */
interface SendMessageInput {
  chatId: string;
  content: string;
  mode: ChatMode;
  participants: string[];
  mentionTarget?: string | null;
  attachments?: PendingAttachmentDraft[];
}

/**
 * useChatStream 钩子的配置选项
 * 提供流式事件完成后的回调钩子
 */
interface UseChatStreamOptions {
  /** 当消息列表发生变化时（消息存入数据库后）触发的回调 */
  onMessagesChanged: () => Promise<void>;
}

/**
 * 聊天流式消息钩子
 *
 * 管理基于 SSE（Server-Sent Events）的流式对话完整生命周期：
 * - 草稿：各角色正在实时接收的消息文本
 * - 代理状态：各角色的当前处理状态描述
 * - 流式状态：是否正在传输、错误信息等
 *
 * @param options - 配置选项，包含消息变更回调
 * @returns 流式状态（drafts、agentStatus、activeRoleId、isStreaming、error）
 *          与控制方法（sendMessage、resetStream）
 */
export function useChatStream(options: UseChatStreamOptions) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [agentStatus, setAgentStatus] = useState<Record<string, string>>({});
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 用 ref 跟踪流式状态，避免闭包中读到过期的 state 值
  // sendMessage 是 useCallback 的依赖项，用 ref 可以在不重建回调的前提下获取最新值
  const isStreamingRef = useRef(false);

  const orderedDrafts = useMemo(() => drafts, [drafts]);

  /**
   * 重置所有流式状态
   * 通常在用户手动停止或发生错误时调用
   */
  function resetStream(): void {
    isStreamingRef.current = false;
    setIsStreaming(false);
    setError(null);
    setDrafts({});
    setAgentStatus({});
    setActiveRoleId(null);
  }

  /**
   * 发送消息并启动 SSE 流式对话
   *
   * 流程：调用 API 获取流地址 → 建立 EventSource 连接 →
   * 监听 status / token / message_done / audio_ready / audio_failed / error 事件
   *
   * @param input - 发送消息所需的参数
   */
  async function sendMessage(input: SendMessageInput): Promise<void> {
    // 前端并发防护：正在流式输出时拒绝新请求
    // 后端也有 findActiveChatJob 兜底，但前端提前拦截可以避免无意义的网络请求和乐观更新回滚
    if (isStreamingRef.current) {
      setError("正在生成回复，请稍后再试");
      return;
    }
    isStreamingRef.current = true;
    setIsStreaming(true);
    setError(null);
    setDrafts({});
    setAgentStatus({});
    setActiveRoleId(null);

    let stream;
    try {
      stream = await apiClient.sendMessage({
        chatId: input.chatId,
        content: input.content,
        mode: input.mode,
        participants: input.participants,
        mentionTarget: input.mentionTarget,
        attachments: input.attachments,
      });
    } catch (error) {
      isStreamingRef.current = false;
      setIsStreaming(false);
      setError(error instanceof Error ? error.message : "发送消息失败，请检查网络连接或后端服务");
      throw error;
    }

    await new Promise<void>((resolve) => {
      const source = new EventSource(stream.streamUrl);
      // 防止 error 事件与 onerror 重复处理：后端发送 SSE error 事件后会关闭流，
      // 浏览器随后触发 onerror，此时状态已清理，无需重复操作
      let settled = false;

      /** 统一的结束处理：关闭连接、刷新消息、resolve Promise。幂等，多次调用安全。 */
      const finishStream = async () => {
        if (settled) return;
        settled = true;
        source.close();
        isStreamingRef.current = false;
        setIsStreaming(false);
        setActiveRoleId(null);
        await options.onMessagesChanged();
        resolve();
      };

      /** 统一的错误处理：清理草稿、设置错误信息、结束流。幂等。 */
      const handleError = async (message: string) => {
        if (settled) return;
        settled = true;
        source.close();
        isStreamingRef.current = false;
        setIsStreaming(false);
        setActiveRoleId(null);
        setError(message);
        setDrafts({});
        setAgentStatus({});
        await options.onMessagesChanged();
        resolve();
      };

      // 安全解析 JSON：解析失败时返回 null，避免异常导致流崩溃
      const safeParse = <T,>(raw: string): T | null => {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      };

      // 监听角色状态变更事件：某个角色开始/结束发言时的状态描述
      source.addEventListener("status", (event) => {
        const payload = safeParse<{ roleId?: string | null; message: string }>(
          (event as MessageEvent<string>).data,
        );
        if (!payload) return;
        const roleId = payload.roleId ?? "__default__";
        setActiveRoleId(payload.roleId ?? null);
        setAgentStatus((current) => ({
          ...current,
          [roleId]: payload.message,
        }));
        setDrafts((current) => {
          if (current[roleId] !== undefined) return current;
          return { ...current, [roleId]: "" };
        });
      });

      /** 跟踪每个角色是否已收到 message_done，用于检测重试导致的重复 token 流 */
      const completedRoles = new Set<string>();

      // 监听 token 事件：逐词接收角色生成的文本片段，追加到对应草稿中
      // 已收到 message_done 的角色忽略后续 token（验证重试时后端会重新发布 token）
      source.addEventListener("token", (event) => {
        const payload = safeParse<{ roleId?: string | null; token: string }>(
          (event as MessageEvent<string>).data,
        );
        if (!payload) return;
        const roleId = payload.roleId ?? "__default__";
        if (completedRoles.has(roleId)) return;
        setActiveRoleId(payload.roleId ?? null);
        setDrafts((current) => ({
          ...current,
          [roleId]: `${current[roleId] ?? ""}${payload.token}`,
        }));
      });

      // 监听消息完成事件：某个角色的消息已写入数据库，从草稿列表中移除
      source.addEventListener("message_done", async (event) => {
        const payload = safeParse<{ roleId?: string | null }>(
          (event as MessageEvent<string>).data,
        );
        if (!payload) return;
        const roleId = payload.roleId ?? "__default__";
        completedRoles.add(roleId);
        setDrafts((current) => {
          const next = { ...current };
          delete next[roleId];
          return next;
        });
        setAgentStatus((current) => {
          const next = { ...current };
          delete next[roleId];
          return next;
        });
        await options.onMessagesChanged();
      });

      // 监听音频就绪事件：语音合成完成，刷新消息列表以获取音频 URL
      source.addEventListener("audio_ready", async () => {
        await options.onMessagesChanged();
      });

      // 监听音频失败事件：语音合成失败，刷新消息列表以获取失败状态
      source.addEventListener("audio_failed", async () => {
        await options.onMessagesChanged();
      });

      // 监听错误事件：后端通过 SSE 推送的业务错误（如 LLM 调用失败、agent 异常）
      // 必须调用 resolve() 结束 Promise，否则 sendMessage 永远 await，且 EventSource 不会关闭
      source.addEventListener("error", (event) => {
        const payload = safeParse<{ message?: string }>((event as MessageEvent<string>).data);
        handleError(payload?.message ?? "流式对话失败");
      });

      // 连接层错误（网络中断、后端关闭流等）：结束本次流式对话
      // 后端正常关闭流时也会触发 onerror（EventSource 收到 EOF），此时 settled 已为 true，finishStream 幂等返回
      source.onerror = () => {
        void finishStream();
      };
    });
  }

  return {
    drafts: orderedDrafts,
    agentStatus,
    activeRoleId,
    isStreaming,
    error,
    sendMessage,
    resetStream,
  };
}

