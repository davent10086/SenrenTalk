import { useMemo, useState } from "react";
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

  const orderedDrafts = useMemo(() => drafts, [drafts]);

  /**
   * 重置所有流式状态
   * 通常在用户手动停止或发生错误时调用
   */
  function resetStream(): void {
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
      setIsStreaming(false);
      setError(error instanceof Error ? error.message : "发送消息失败，请检查网络连接或后端服务");
      throw error;
    }

    await new Promise<void>((resolve) => {
      const source = new EventSource(stream.streamUrl);

      // 监听角色状态变更事件：某个角色开始/结束发言时的状态描述
      source.addEventListener("status", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          roleId?: string | null;
          message: string;
        };
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

      // 监听 token 事件：逐词接收角色生成的文本片段，追加到对应草稿中
      source.addEventListener("token", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          roleId?: string | null;
          token: string;
        };
        const roleId = payload.roleId ?? "__default__";
        setActiveRoleId(payload.roleId ?? null);
        setDrafts((current) => ({
          ...current,
          [roleId]: `${current[roleId] ?? ""}${payload.token}`,
        }));
      });

      // 监听消息完成事件：某个角色的消息已写入数据库，从草稿列表中移除
      source.addEventListener("message_done", async (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          roleId?: string | null;
        };
        const roleId = payload.roleId ?? "__default__";
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

      // 监听错误事件：流式对话过程中发生错误，终止流并设置错误信息
      source.addEventListener("error", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { message?: string };
        setIsStreaming(false);
        setActiveRoleId(null);
        setError(payload.message ?? "流式对话失败");
        setDrafts({});
        setAgentStatus({});
        options.onMessagesChanged();
      });

      // 连接层错误（网络中断等）：关闭连接、刷新消息列表、结束本次流式对话
      source.onerror = async () => {
        source.close();
        setIsStreaming(false);
        setActiveRoleId(null);
        await options.onMessagesChanged();
        resolve();
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

