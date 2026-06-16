import { randomUUID } from "node:crypto";
import type { BackendJob, BackendJobStatus, BackendJobType } from "../common/types";

interface CreateJobInput {
  type: BackendJobType;
  chatId?: string;
  streamId?: string;
}

export class JobRegistry {
  private readonly jobs = new Map<string, BackendJob>();
  private sequence = 0;

  createJob(input: CreateJobInput): BackendJob {
    const job: BackendJob = {
      id: randomUUID(),
      type: input.type,
      status: "pending",
      createdAt: Date.now() + this.sequence++ / 1000,
      chatId: input.chatId,
      streamId: input.streamId,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  updateJob(
    jobId: string,
    status: BackendJobStatus,
    extra: Partial<Omit<BackendJob, "id" | "type" | "createdAt" | "status">> = {},
  ): BackendJob {
    const current = this.getJob(jobId);
    const next: BackendJob = {
      ...current,
      ...extra,
      status,
      startedAt:
        status === "running"
          ? extra.startedAt ?? current.startedAt ?? Date.now()
          : extra.startedAt ?? current.startedAt,
      finishedAt:
        status === "completed" || status === "failed"
          ? extra.finishedAt ?? Date.now()
          : extra.finishedAt ?? current.finishedAt,
    };
    this.jobs.set(jobId, next);
    return next;
  }

  getJob(jobId: string): BackendJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`未找到任务 ${jobId}`);
    }
    return job;
  }

  listJobs(): BackendJob[] {
    return Array.from(this.jobs.values()).sort((left, right) => right.createdAt - left.createdAt);
  }

  findRunningChatJob(chatId: string): BackendJob | undefined {
    return this.listJobs().find((job) => job.type === "chat" && job.chatId === chatId && job.status === "running");
  }
}
