/**
 * 统一 API 服务层
 *
 * P0: 消除双运行时 API 处理逻辑重复。
 * 将 Express 和 WorkerRuntime 共同需要的业务操作集中在此层，
 * 两者都委托给该类，避免逻辑分散。
 */
import type { ChatMessage, ChatMode, ChatRecord, ChatRequest, ChatSendResult, BootstrapPayload, PublicSettings } from "../common/types";
import { AppRuntime } from "../backend/app-runtime";
import { JobRegistry } from "../backend/job-registry";

export class ApiService {
  readonly runtime: AppRuntime;
  readonly jobs: JobRegistry;

  constructor(appRoot: string, userDataPath: string) {
    this.runtime = new AppRuntime(appRoot, userDataPath);
    this.jobs = new JobRegistry();
  }

  // ── 生命周期 ──

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }

  // ── 元数据 ──

  getBootstrapPayload(): BootstrapPayload {
    return this.runtime.getBootstrapPayload();
  }

  getPublicSettings(): PublicSettings {
    return this.runtime.getPublicSettings();
  }

  resolveMediaUrl(relativePath: string): string {
    return this.runtime.resolveMediaUrl(relativePath);
  }

  // ── 聊天 CRUD ──

  listChats(): ChatRecord[] {
    return this.runtime.listChats();
  }

  listMessages(chatId: string): ChatMessage[] {
    return this.runtime.listMessages(chatId);
  }

  createChat(mode: ChatMode, participants: string[], title?: string): ChatRecord {
    return this.runtime.createChat(mode, participants, title);
  }

  async clearMessages(chatId: string): Promise<void> {
    await this.runtime.clearMessages(chatId);
  }

  async deleteChat(chatId: string): Promise<void> {
    await this.runtime.deleteChat(chatId);
  }

  async regenerateMessageAudio(messageId: string): Promise<ChatMessage> {
    return this.runtime.regenerateMessageAudio(messageId);
  }

  async rebuildDialogueIndex(): Promise<{ indexedCount: number }> {
    return this.runtime.rebuildDialogueIndex();
  }

  async sendMessage(request: ChatRequest, hooks?: {
    jobId?: string;
    onJobRunning?: (jobId: string, streamId: string) => void;
    onJobCompleted?: (jobId: string) => void;
    onJobFailed?: (jobId: string, errorMessage: string) => void;
  }): Promise<ChatSendResult> {
    return this.runtime.sendMessage(request, hooks);
  }

  // ── Job 管理 ──

  listJobs() {
    return this.jobs.listJobs();
  }

  /**
   * 启动索引构建的异步任务。
   * 检查是否已有运行中的任务，避免重复执行。
   */
  async startDialogueIndexJob() {
    const runningJob = this.jobs.listJobs().find(
      (job) => job.type === "index_dialogues" && job.status === "running",
    );
    if (runningJob) {
      return runningJob;
    }

    const job = this.jobs.createJob({ type: "index_dialogues" });
    this.jobs.updateJob(job.id, "running");

    queueMicrotask(async () => {
      try {
        const result = await this.runtime.rebuildDialogueIndex();
        this.jobs.updateJob(job.id, "completed", {
          result: { indexedCount: result.indexedCount },
        });
      } catch (error) {
        this.jobs.updateJob(job.id, "failed", {
          error: error instanceof Error ? error.message : "索引构建失败",
        });
      }
    });

    return this.jobs.getJob(job.id);
  }

  /**
   * 查找指定 chatId 的运行中任务。
   * 用于并发控制，防止同一会话同时生成多条回复。
   */
  findRunningChatJob(chatId: string) {
    return this.jobs.findRunningChatJob(chatId);
  }
}

