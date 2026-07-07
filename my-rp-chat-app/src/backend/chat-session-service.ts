import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { createDefaultGroupChatRoomConfig } from "../common/types";
import type { AppConfig } from "./config";
import type { ChatRepository } from "./db/database";
import { createSingleChatGraph } from "./graph/chat-graphs";
import type { ChatGraphState, GraphDependencies } from "./graph/graph-types";
import { GroupChatCoordinator } from "./graph/group-coordinator";
import type { MemoryService } from "./services/memory/memory-service";
import type { SseService } from "./services/stream/sse-service";
import type {
  ChatMessage,
  ChatRecord,
  ChatRequest,
  ChatSendResult,
} from "../common/types";

export interface ChatJobHooks {
  jobId?: string;
  signal?: AbortSignal;
  onJobRunning?: (jobId: string, streamId: string) => void;
  onJobCompleted?: (jobId: string) => void;
  onJobFailed?: (jobId: string, errorMessage: string) => void;
  onJobCancelled?: (jobId: string) => void;
}

interface ChatSessionServiceOptions {
  config: AppConfig;
  repository: ChatRepository;
  sseService: SseService;
  memoryService: MemoryService;
  baseGraphDependencies: Omit<GraphDependencies, "trackAsyncJob">;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class ChatSessionService {
  constructor(private readonly options: ChatSessionServiceOptions) {}

  launchGeneration(
    chat: ChatRecord,
    request: Pick<ChatRequest, "mode" | "participants" | "mentionTarget" | "targetRoleId">,
    hooks: ChatJobHooks = {},
  ): ChatSendResult {
    const { config, repository, sseService, baseGraphDependencies } = this.options;
    const stream = sseService.createSession();
    const orderedParticipants =
      request.mode === "group" && (request.targetRoleId ?? request.mentionTarget)
        ? [
            (request.targetRoleId ?? request.mentionTarget)!,
            ...request.participants.filter(
              (participant) => participant !== (request.targetRoleId ?? request.mentionTarget),
            ),
          ]
        : request.participants;

    const state = {
      chatId: chat.id,
      streamId: stream.streamId,
      mode: request.mode,
      participants:
        request.mode === "single"
          ? [orderedParticipants[0] ?? chat.participants[0]]
          : orderedParticipants,
      mentionTarget: request.targetRoleId ?? request.mentionTarget ?? null,
      activeRoleIndex: 0,
      currentRoleId:
        request.mode === "single" ? orderedParticipants[0] ?? chat.participants[0] : undefined,
      messages: repository.listMessages(chat.id),
      retrievedDocs: [],
      memories: [],
      summary: repository.getSummary(
        chat.id,
        request.mode === "single" ? (orderedParticipants[0] ?? chat.participants[0]) : undefined,
      ),
      prompt: "",
      output: "",
      speechTextJa: "",
      retryCount: 0,
      validationIssue: undefined,
      character: undefined,
    };

    const backgroundJobs: Promise<unknown>[] = [];
    const graphDependencies: GraphDependencies = {
      ...baseGraphDependencies,
      abortSignal: hooks.signal,
      trackAsyncJob: (job) => {
        backgroundJobs.push(job);
      },
    };

    if (hooks.jobId) {
      hooks.onJobRunning?.(hooks.jobId, stream.streamId);
    }

    const tracer =
      config.langsmithTracing && config.langsmithApiKey
        ? new LangChainTracer({ projectName: config.langsmithProject })
        : undefined;

    void (async () => {
      try {
        if (request.mode === "group") {
          const coordinator = new GroupChatCoordinator(
            graphDependencies,
            chat.roomConfig ?? createDefaultGroupChatRoomConfig(orderedParticipants.length),
          );
          await coordinator.runSession({
            chatId: chat.id,
            streamId: stream.streamId,
            participants: orderedParticipants,
            mentionTarget: request.targetRoleId ?? request.mentionTarget ?? null,
            messages: state.messages,
            tracer,
          });
        } else {
          const runner = createSingleChatGraph(graphDependencies);
          const invokeConfig: Record<string, unknown> = { recursionLimit: 100 };
          if (tracer) {
            invokeConfig.callbacks = [tracer];
          }

          const result = (await runner.invoke(state, invokeConfig)) as ChatGraphState;
          const memoryJob = this.processSingleChatMemories(
            chat.id,
            state.currentRoleId ?? state.participants[0],
            result.messages ?? state.messages,
          );
          graphDependencies.trackAsyncJob?.(memoryJob);
        }

        await Promise.allSettled(backgroundJobs);
        if (hooks.jobId) {
          hooks.onJobCompleted?.(hooks.jobId);
        }
      } catch (error) {
        if (isAbortError(error)) {
          if (hooks.jobId) {
            hooks.onJobCancelled?.(hooks.jobId);
          }
          return;
        }

        const errorMessage = error instanceof Error ? error.message : "未知错误";
        sseService.publish({
          type: "error",
          streamId: stream.streamId,
          message: errorMessage,
        });
        if (hooks.jobId) {
          hooks.onJobFailed?.(hooks.jobId, errorMessage);
        }
      } finally {
        sseService.close(stream.streamId);
      }
    })();

    return {
      jobId: hooks.jobId ?? stream.streamId,
      ...stream,
    };
  }

  private async processSingleChatMemories(
    chatId: string,
    roleId: string,
    finalHistory: ChatMessage[],
  ): Promise<void> {
    const { repository, memoryService } = this.options;

    try {
      const character = repository.getCharacter(roleId);
      if (!character) {
        return;
      }

      await memoryService.extractAndPersist(chatId, character, finalHistory);
      await memoryService.consolidateCoreMemory(chatId, character);
    } catch (error) {
      console.warn(`[ChatSessionService] single-chat memory processing failed for ${roleId}:`, error);
    }
  }
}
