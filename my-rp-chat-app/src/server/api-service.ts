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

  async sendMessage(request: ChatRequest): Promise<ChatSendResult> {
    // 并发控制：同一会话已有活跃任务（pending 或 running）时拒绝新请求
    // 必须在创建 job 之前同步检查，避免 await 期间产生竞态窗口
    const activeJob = this.jobs.findActiveChatJob(request.chatId);
    if (activeJob) {
      const error = new Error("该会话正在生成回复，请稍后再试") as Error & { statusCode: number };
      error.statusCode = 409;
      throw error;
    }

    // 创建 chat job 并同步注册到 JobRegistry，确保后续并发请求能检测到
    const job = this.jobs.createJob({ type: "chat", chatId: request.chatId });

    try {
      return await this.runtime.sendMessage(request, {
        jobId: job.id,
        onJobRunning: (jobId, streamId) => {
          this.jobs.updateJob(jobId, "running", { streamId });
        },
        onJobCompleted: (jobId) => {
          this.jobs.updateJob(jobId, "completed");
        },
        onJobFailed: (jobId, errorMessage) => {
          this.jobs.updateJob(jobId, "failed", { error: errorMessage });
        },
      });
    } catch (error) {
      // runtime.sendMessage 在 queueMicrotask 之前抛出时（如会话不存在、附件持久化失败），
      // job hooks 不会触发，需在此标记为 failed，避免 job 永远停留在 pending 阻塞后续请求
      this.jobs.updateJob(job.id, "failed", {
        error: error instanceof Error ? error.message : "发送消息失败",
      });
      throw error;
    }
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

