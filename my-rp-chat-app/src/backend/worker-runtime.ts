import { ApiService } from "../server/api-service";
import type { BackendJob, BootstrapPayload, ChatMessage, ChatMode, ChatRecord, ChatRequest, ChatSendResult, PublicSettings } from "../common/types";

/**
 * 工作线程运行时 — 作为 Electron Worker 的 API 入口。
 *
 * 委托给 {@link ApiService} 处理所有业务逻辑，
 * WorkerRuntime 本身只做方法名映射，保证 IPC 路由畅通。
 */
export class WorkerRuntime {
  private readonly api: ApiService;

  constructor(appRoot: string, userDataPath: string) {
    this.api = new ApiService(appRoot, userDataPath);
  }

  async start(): Promise<void> {
    await this.api.start();
  }

  async dispose(): Promise<void> {
    await this.api.dispose();
  }

  getBootstrapPayload(): BootstrapPayload {
    return this.api.getBootstrapPayload();
  }

  getPublicSettings(): PublicSettings {
    return this.api.getPublicSettings();
  }

  resolveMediaUrl(relativePath: string): string {
    return this.api.resolveMediaUrl(relativePath);
  }

  listChats(): ChatRecord[] {
    return this.api.listChats();
  }

  listMessages(chatId: string): ChatMessage[] {
    return this.api.listMessages(chatId);
  }

  regenerateMessageAudio(messageId: string): Promise<ChatMessage> {
    return this.api.regenerateMessageAudio(messageId);
  }

  async clearMessages(chatId: string): Promise<void> {
    await this.api.clearMessages(chatId);
  }

  createChat(mode: ChatMode, participants: string[], title?: string): ChatRecord {
    return this.api.createChat(mode, participants, title);
  }

  listJobs(): BackendJob[] {
    return this.api.listJobs();
  }

  async startDialogueIndexJob(): Promise<BackendJob> {
    return this.api.startDialogueIndexJob();
  }

  async sendMessage(request: ChatRequest): Promise<ChatSendResult> {
    return this.api.sendMessage(request);
  }
}



