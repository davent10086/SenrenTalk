/**
 * API 客户端模块
 * 封装所有与后端 API 的通信方法，包括会话管理、消息发送、媒体资源解析等功能。
 */
import type {
  BackendJob,
  BootstrapPayload,
  ChatMessage,
  ChatRecord,
  ChatRequest,
  ChatSendResult,
  PublicSettings,
} from "../../common/types";
import type { PendingAttachmentDraft } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

function buildApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * 将媒体文件的相对路径解析为完整的可访问 URL
 * @param relativePath - 媒体文件的相对路径（如 "images/avatar.png"）
 * @returns 编码后的完整媒体 URL
 */
export function resolveMediaUrl(relativePath: string): string {
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return buildApiUrl(`/media/${encodedPath}`);
}

/**
 * 应用启动引导，获取初始化所需的完整配置数据（包含公开设置和用户会话信息）
 * @returns 启动引导数据载荷
 */
export async function bootstrap(): Promise<BootstrapPayload> {
  return readJsonResponse<BootstrapPayload>(await fetch(buildApiUrl("/api/bootstrap")));
}

/**
 * 获取应用的公开设置（如可用角色列表、模型配置等）
 * @returns 公开设置对象
 */
export async function getSettings(): Promise<PublicSettings> {
  return readJsonResponse<PublicSettings>(await fetch(buildApiUrl("/api/settings")));
}

/**
 * 获取当前用户的所有会话记录列表
 * @returns 会话记录数组
 */
export async function listChats(): Promise<ChatRecord[]> {
  return readJsonResponse<ChatRecord[]>(await fetch(buildApiUrl("/api/chats")));
}

/**
 * 获取指定会话的所有消息记录
 * @param chatId - 会话 ID
 * @returns 消息数组
 */
export async function listMessages(chatId: string): Promise<ChatMessage[]> {
  return readJsonResponse<ChatMessage[]>(await fetch(buildApiUrl(`/api/chats/${encodeURIComponent(chatId)}/messages`)));
}

/**
 * 获取所有后台任务的列表（如对话索引构建等异步任务）
 * @returns 后台任务数组
 */
export async function listJobs(): Promise<BackendJob[]> {
  return readJsonResponse<BackendJob[]>(await fetch(buildApiUrl("/api/jobs")));
}

/**
 * 创建一个新的聊天会话
 * @param payload.mode - 聊天模式（如单人、群聊等）
 * @param payload.participants - 参与者角色 ID 列表
 * @param payload.title - 可选的会话标题
 * @returns 新创建的会话记录
 */
export async function createChat(payload: {
  mode: ChatRequest["mode"];
  participants: string[];
  title?: string;
}): Promise<ChatRecord> {
  return readJsonResponse<ChatRecord>(
    await fetch(buildApiUrl("/api/chats"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  );
}

/**
 * 清空指定会话中的所有消息
 * @param chatId - 会话 ID
 */
export async function clearMessages(chatId: string): Promise<void> {
  await readJsonResponse<void>(
    await fetch(buildApiUrl(`/api/chats/${encodeURIComponent(chatId)}/clear`), {
      method: "POST",
    }),
  );
}

/**
 * 删除指定会话及其所有关联数据
 * @param chatId - 会话 ID
 */
export async function deleteChat(chatId: string): Promise<void> {
  await readJsonResponse<void>(
    await fetch(buildApiUrl(`/api/chats/${encodeURIComponent(chatId)}`), {
      method: "DELETE",
    }),
  );
}

/**
 * 启动对话索引构建后台任务（用于检索增强生成等场景）
 * @returns 新创建的后台任务对象
 */
export async function startDialogueIndexJob(): Promise<BackendJob> {
  return readJsonResponse<BackendJob>(
    await fetch(buildApiUrl("/api/jobs/dialogue-index"), {
      method: "POST",
    }),
  );
}

/**
 * 重新生成指定消息的 TTS 语音音频
 * @param messageId - 消息 ID
 * @returns 更新后的消息对象（包含新的音频路径）
 */
export async function regenerateMessageAudio(messageId: string): Promise<ChatMessage> {
  return readJsonResponse<ChatMessage>(
    await fetch(buildApiUrl(`/api/messages/${encodeURIComponent(messageId)}/tts-regenerate`), {
      method: "POST",
    }),
  );
}

/**
 * 向指定会话发送消息（支持文本内容和文件附件）
 * 附件以 multipart/form-data 格式上传
 * @param payload - 消息请求载荷，包含内容、模式、参与者及可选附件
 * @returns 消息发送结果（包含用户消息和 AI 回复）
 */
export async function sendMessage(payload: Omit<ChatRequest, "attachments"> & {
  attachments?: PendingAttachmentDraft[];
}): Promise<ChatSendResult> {
  const formData = new FormData();
  formData.append("content", payload.content);
  formData.append("mode", payload.mode);
  formData.append("participants", JSON.stringify(payload.participants));
  if (payload.mentionTarget) {
    formData.append("mentionTarget", payload.mentionTarget);
  }

  const attachments = payload.attachments ?? [];
  formData.append(
    "attachmentsMeta",
    JSON.stringify(
      attachments.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        durationMs: attachment.durationMs,
      })),
    ),
  );
  attachments.forEach((attachment) => {
    formData.append("files", attachment.file, attachment.originalName);
  });

  return readJsonResponse<ChatSendResult>(
    await fetch(buildApiUrl(`/api/chats/${encodeURIComponent(payload.chatId)}/send`), {
      method: "POST",
      body: formData,
    }),
  );
}
