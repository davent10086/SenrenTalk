import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { MediaManager } from "./media-manager";
import type { AppConfig } from "./config";
import { createAppConfig } from "./config";
import { ChatRepository } from "./db/database";
import { createSingleChatGraph, type GraphDependencies } from "./graph/chat-graphs";
import { GroupChatCoordinator } from "./graph/group-coordinator";
import { CharacterService } from "./services/characters/character-service";
import { ElasticsearchService } from "./services/es/elasticsearch-service";
import { DeepSeekService } from "./services/llm/deepseek-service";
import { MemoryService } from "./services/memory/memory-service";
import { SseService } from "./services/stream/sse-service";
import { TtsService } from "./services/tts/tts-service";
import type {
  BootstrapPayload,
  ChatSendResult,
  ChatMessage,
  ChatMessageMetadata,
  ChatMode,
  ChatRecord,
  ChatRequest,
  PublicSettings,
} from "../common/types";

/**
 * 对话 Job 生命周期钩子，用于前端跟踪异步对话生成进度。
 */
interface ChatJobHooks {
  jobId?: string;
  onJobRunning?: (jobId: string, streamId: string) => void;
  onJobCompleted?: (jobId: string) => void;
  onJobFailed?: (jobId: string, errorMessage: string) => void;
}

/**
 * 应用运行时核心类。
 *
 * 负责组装所有服务（数据库、LLM、记忆、TTS、SSE 等），
 * 对外暴露对话 CRUD、消息发送、语音重试等操作入口。
 * 单聊使用 {@link createSingleChatGraph} 直调，群聊通过
 * {@link GroupChatCoordinator} 协调多角色轮流发言。
 */
export class AppRuntime {
  readonly config: AppConfig;
  readonly repository: ChatRepository;
  readonly sseService: SseService;
  readonly characterService: CharacterService;
  readonly elasticsearchService: ElasticsearchService;
  readonly memoryService: MemoryService;
  readonly deepSeekService: DeepSeekService;
  readonly ttsService: TtsService;
  readonly mediaManager: MediaManager;
  private readonly baseGraphDependencies: Omit<GraphDependencies, "trackAsyncJob">;

  /**
   * 构造运行时实例，初始化所有子服务。
   * @param appRoot      项目根目录
   * @param userDataPath 用户数据目录（存放 SQLite、配置文件等）
   */
  constructor(appRoot: string, userDataPath: string) {
    this.config = createAppConfig(appRoot, userDataPath);
    this.repository = new ChatRepository(this.config.sqlitePath);
    this.sseService = new SseService();
    this.characterService = new CharacterService(this.config);
    this.elasticsearchService = new ElasticsearchService(this.config);
    this.deepSeekService = new DeepSeekService(this.config);
    this.memoryService = new MemoryService(this.repository, this.elasticsearchService, this.deepSeekService);
    this.ttsService = new TtsService(this.config);
    this.mediaManager = new MediaManager(this.config);

    this.baseGraphDependencies = {
      repository: this.repository,
      characterService: this.characterService,
      elasticsearchService: this.elasticsearchService,
      deepSeekService: this.deepSeekService,
      memoryService: this.memoryService,
      sseService: this.sseService,
      ttsService: this.ttsService,
    };
  }

  /** 启动所有服务：初始化数据库、加载角色、启动 SSE 服务器、建立 ES 索引。 */
  async start(): Promise<void> {
    this.repository.init();
    const characters = await this.characterService.loadCharacters();
    this.repository.upsertCharacters(characters);
    await this.sseService.start();
    if (this.elasticsearchService.enabled) {
      await this.elasticsearchService.ensureMemoryIndex();
    }
  }

  /** 优雅关闭：停止 SSE 服务器，关闭数据库连接。 */
  async dispose(): Promise<void> {
    await this.sseService.stop();
    this.repository.close();
  }

  /** 返回前端初始化所需的 bootstrap 数据（角色列表、会话列表、SSE 地址）。 */
  getBootstrapPayload(): BootstrapPayload {
    return {
      characters: this.repository.listCharacters(),
      chats: this.repository.listChats(),
      backendBaseUrl: this.sseService.baseUrl,
    };
  }

  /** 返回公开设置（模型名、ES 配置、TTS 信息等），用于前端显示。 */
  getPublicSettings(): PublicSettings {
    return {
      appName: this.config.appName,
      datasetDir: this.config.datasetDir,
      llmModel: this.config.deepseekModel,
      esNode: this.config.esNode,
      dialogueIndex: this.config.esDialogueIndex,
      memoryIndex: this.config.esMemoryIndex,
      esEnabled: this.elasticsearchService.enabled,
      mediaDir: this.config.mediaDir,
      ttsProvider: this.config.ttsProvider,
      ttsEnabled: this.ttsService.isEnabled(),
    };
  }

  /** 列出所有会话。 */
  listChats(): ChatRecord[] {
    return this.repository.listChats();
  }

  /** 列出指定会话的全部消息。 */
  listMessages(chatId: string): ChatMessage[] {
    return this.repository.listMessages(chatId);
  }

  /**
   * 重试生成某条助手消息的 TTS 语音。
   * 若消息已有日语朗读稿则直接合成，否则先调 LLM 生成朗读稿再合成。
   */

  async regenerateMessageAudio(messageId: string): Promise<ChatMessage> {
    if (!this.ttsService.isEnabled()) {
      throw new Error("当前未启用 TTS。");
    }

    const message = this.repository.getMessage(messageId);
    if (!message) {
      throw new Error("消息不存在。");
    }
    if (message.role !== "assistant") {
      throw new Error("只有助手消息支持语音重试。");
    }

    const character = message.roleId ? this.repository.getCharacter(message.roleId) : undefined;
    if (!character) {
      throw new Error("未找到消息对应角色，无法重试语音。");
    }

    const metadata: ChatMessageMetadata = {
      ...(message.metadata ?? {}),
      audio: {
        status: "pending",
        voiceId: this.ttsService.resolveVoiceId(character.id),
      },
    };
    this.repository.updateMessageMetadata(messageId, metadata);

    try {
      const speechTextJa = metadata.speechTextJa
        ?? await this.deepSeekService.generateSpeechTextJa({
          characterName: character.displayName,
          selfAddress: character.promptProfile.selfAddress,
          content: message.content,
        });
      const audio = await this.ttsService.synthesize({
        chatId: message.chatId,
        messageId: message.id,
        roleId: character.id,
        text: speechTextJa || message.content,
      });
      this.repository.updateMessageAudio(messageId, audio, {
        ...metadata,
        speechTextJa,
      });
    } catch (error) {
      this.repository.updateMessageAudio(messageId, {
        status: "failed",
        voiceId: this.ttsService.resolveVoiceId(character.id),
        error: error instanceof Error ? error.message : "语音重试失败",
      }, metadata);
    }

    const updated = this.repository.getMessage(messageId);
    if (!updated) {
      throw new Error("语音重试后消息丢失。");
    }
    return updated;
  }

  /** 清空指定会话的消息，同时删除 ES 中关联的记忆。 */
  async clearMessages(chatId: string): Promise<void> {
    await this.elasticsearchService.deleteMemoriesBySession(chatId);
    this.repository.clearMessages(chatId);
  }

  /** 删除指定会话及其所有关联数据，同时删除 ES 中关联的记忆。 */
  async deleteChat(chatId: string): Promise<void> {
    await this.elasticsearchService.deleteMemoriesBySession(chatId);
    this.repository.deleteChat(chatId);
  }

  /** 创建新会话。 */
  createChat(mode: ChatMode, participants: string[], title?: string): ChatRecord {
    return this.repository.createChat(mode, participants, title);
  }

  /** 将媒体相对路径转为 file:// URL。 */
  resolveMediaUrl(relativePath: string): string {
    return pathToFileURL(path.join(this.config.mediaDir, relativePath)).href;
  }

  /** 重建 Elasticsearch 对话索引。 */
  async rebuildDialogueIndex(): Promise<{ indexedCount: number }> {
    return this.elasticsearchService.buildDialogueIndex();
  }

  /**
   * 发送用户消息并触发 AI 回复。
   *
   * 流程：
   * 1. 校验会话存在
   * 2. 持久化附件 + 用户消息
   * 3. 创建 SSE 流式通道
   * 4. 单聊：直接调用 createSingleChatGraph；
   *    群聊：通过 GroupChatCoordinator 协调多角色发言
   * 5. 通过 queueMicrotask 异步执行，立即返回 stream URL 给前端
   *
   * @returns 包含 jobId 和 streamUrl，前端据此订阅 SSE 事件
   */
  async sendMessage(request: ChatRequest, hooks: ChatJobHooks = {}): Promise<ChatSendResult> {
    const chat = this.repository.getChat(request.chatId);
    if (!chat) {
      throw new Error("会话不存在，请先创建会话。");
    }

    // 1. 持久化用户消息和附件
    const userMessageId = randomUUID();
    const userAttachments = await this.mediaManager.persistAttachments(
      request.chatId,
      userMessageId,
      request.attachments ?? [],
    );
    const userContent = request.content.trim() || (userAttachments.length > 0 ? "[图片]" : "");
    const userMetadata: ChatMessageMetadata | undefined = userAttachments.length > 0
      ? { attachments: userAttachments }
      : undefined;

    this.repository.appendMessage({
      id: userMessageId,
      chatId: request.chatId,
      role: "user",
      content: userContent,
      metadata: userMetadata,
    });

    // 2. 创建 SSE 流式通道
    const stream = this.sseService.createSession();
    // 若有 @mention 目标，将其排到参与列表第一位
    const orderedParticipants =
      request.mode === "group" && request.mentionTarget
        ? [
            request.mentionTarget,
            ...request.participants.filter((participant) => participant !== request.mentionTarget),
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
      mentionTarget: request.mentionTarget ?? null,
      activeRoleIndex: 0,
      currentRoleId:
        request.mode === "single" ? orderedParticipants[0] ?? chat.participants[0] : undefined,
      messages: this.repository.listMessages(chat.id),
      retrievedDocs: [],
      memories: [],
      summary: this.repository.getSummary(chat.id),
      prompt: "",
      output: "",
      speechTextJa: "",
      retryCount: 0,
      validationIssue: undefined,
      character: undefined,
    };

    const backgroundJobs: Promise<unknown>[] = [];
    const graphDependencies: GraphDependencies = {
      ...this.baseGraphDependencies,
      trackAsyncJob: (job) => {
        backgroundJobs.push(job);
      },
    };
    if (hooks.jobId) {
      hooks.onJobRunning?.(hooks.jobId, stream.streamId);
    }

    // 初始化 LangSmith tracer（若启用）
    const tracer =
      this.config.langsmithTracing && this.config.langsmithApiKey
        ? new LangChainTracer({ projectName: this.config.langsmithProject })
        : undefined;

    // 3. 在 microtask 中异步执行 agent 流程，不阻塞响应返回
    queueMicrotask(async () => {
      try {
        if (request.mode === "group") {
          const coordinator = new GroupChatCoordinator(graphDependencies);
          await coordinator.runSession({
            chatId: chat.id,
            streamId: stream.streamId,
            participants: orderedParticipants,
            mentionTarget: request.mentionTarget ?? null,
            messages: state.messages,
            tracer,
          });
        } else {
          const runner = createSingleChatGraph(graphDependencies);
          const config: Record<string, unknown> = { recursionLimit: 100 };
          if (tracer) {
            config.callbacks = [tracer];
          }
          await runner.invoke(state, config);
        }
        await Promise.allSettled(backgroundJobs);
        if (hooks.jobId) {
          hooks.onJobCompleted?.(hooks.jobId);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "未知错误";
        this.sseService.publish({
          type: "error",
          streamId: stream.streamId,
          message: errorMessage,
        });
        if (hooks.jobId) {
          hooks.onJobFailed?.(hooks.jobId, errorMessage);
        }
      } finally {
        this.sseService.close(stream.streamId);
      }
    });

    return {
      jobId: hooks.jobId ?? stream.streamId,
      ...stream,
    };
  }

  /**
   * 将用户上传的附件复制到 mediaDir/images/{chatId}/ 目录，
   * 返回可用于持久化到数据库的相对路径信息。
   */
}





