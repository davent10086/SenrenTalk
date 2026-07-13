import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ChatSessionService, type ChatJobHooks } from "./chat-session-service";
import { MediaManager } from "./media-manager";
import type { AppConfig } from "./config";
import { createAppConfig } from "./config";
import { ChatRepository } from "./db/database";
import type { GraphDependencies } from "./graph/graph-types";
import { CharacterService } from "./services/characters/character-service";
import { ElasticsearchService } from "./services/es/elasticsearch-service";
import { LlmService, type ImageInput } from "./services/llm/llm-service";
import { MemoryService } from "./services/memory/memory-service";
import { SseService } from "./services/stream/sse-service";
import { TtsService } from "./services/tts/tts-service";
import type {
  BackendJobProgress,
  BootstrapPayload,
  ChatSendResult,
  ChatMessage,
  ChatMessageMetadata,
  ChatMode,
  ChatRecord,
  ChatRequest,
  GroupChatRoomConfig,
  GroupChatRoomState,
  PublicSettings,
} from "../common/types";

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
  readonly llmService: LlmService;
  readonly ttsService: TtsService;
  readonly mediaManager: MediaManager;
  private readonly chatSessionService: ChatSessionService;
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
    this.llmService = new LlmService(this.config);
    this.memoryService = new MemoryService(this.repository, this.elasticsearchService, this.llmService);
    this.ttsService = new TtsService(this.config);
    this.mediaManager = new MediaManager(this.config);

    this.baseGraphDependencies = {
      repository: this.repository,
      characterService: this.characterService,
      elasticsearchService: this.elasticsearchService,
      llmService: this.llmService,
      memoryService: this.memoryService,
      sseService: this.sseService,
      ttsService: this.ttsService,
      readImageAsBase64: (relativePath) => this.readImageAsBase64(relativePath),
    };
    this.chatSessionService = new ChatSessionService({
      config: this.config,
      repository: this.repository,
      sseService: this.sseService,
      memoryService: this.memoryService,
      baseGraphDependencies: this.baseGraphDependencies,
    });
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
      llmModel: this.config.llmModel,
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
        ?? await this.llmService.generateSpeechTextJa({
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

  /** 清空指定会话的消息，同时删除 ES 中关联的记忆和媒体文件（图片/音频）。 */
  async clearMessages(chatId: string): Promise<void> {
    if (!this.repository.getChat(chatId)) {
      throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    }
    await this.elasticsearchService.deleteMemoriesBySession(chatId);
    this.repository.clearMessages(chatId);
    await this.mediaManager.cleanupChatMedia(chatId);
  }

  /** 删除指定会话及其所有关联数据，同时删除 ES 中关联的记忆和媒体文件（图片/音频）。 */
  async deleteChat(chatId: string): Promise<void> {
    if (!this.repository.getChat(chatId)) {
      throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    }
    await this.elasticsearchService.deleteMemoriesBySession(chatId);
    this.repository.deleteChat(chatId);
    await this.mediaManager.cleanupChatMedia(chatId);
  }

  /** 创建新会话。 */
  createChat(
    mode: ChatMode,
    participants: string[],
    title?: string,
    roomConfig?: Partial<GroupChatRoomConfig>,
  ): ChatRecord {
    return this.repository.createChat(mode, participants, title, roomConfig);
  }

  updateGroupChatRoom(
    chatId: string,
    updates: {
      roomConfig?: Partial<GroupChatRoomConfig>;
      roomState?: Partial<GroupChatRoomState>;
    },
  ): ChatRecord {
    let nextChat = this.repository.getChat(chatId);
    if (!nextChat) {
      throw new Error("会话不存在，请先创建会话。");
    }

    if (updates.roomConfig) {
      nextChat = this.repository.updateChatRoomConfig(chatId, updates.roomConfig);
    }
    if (updates.roomState) {
      nextChat = this.repository.updateChatRoomState(chatId, updates.roomState);
    }

    return nextChat;
  }

  /** 将媒体相对路径转为 file:// URL。 */
  resolveMediaUrl(relativePath: string): string {
    return this.mediaManager.resolveMediaUrl(relativePath);
  }

  /** 读取媒体图片为 base64，用于多模态 LLM 图片理解。 */
  async readImageAsBase64(relativePath: string): Promise<ImageInput | null> {
    try {
      const absolutePath = this.mediaManager.resolveMediaPath(relativePath);
      const buffer = await fs.readFile(absolutePath);
      const ext = path.extname(relativePath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png"
        : ext === ".webp" ? "image/webp"
        : ext === ".gif" ? "image/gif"
        : "image/jpeg";
      return { mimeType, base64: buffer.toString("base64") };
    } catch {
      return null;
    }
  }

  /** 重建 Elasticsearch 对话索引。 */
  async rebuildDialogueIndex(
    onProgress?: (progress: BackendJobProgress) => void,
  ): Promise<{ indexedCount: number }> {
    return this.elasticsearchService.buildDialogueIndex(onProgress);
  }

  private async cleanupMessagesMedia(messages: ChatMessage[]): Promise<void> {
    const relativePaths = messages.flatMap((message) => {
      const attachments = message.metadata?.attachments?.map((attachment) => attachment.relativePath) ?? [];
      const audio = message.metadata?.audio?.relativePath ? [message.metadata.audio.relativePath] : [];
      return [...attachments, ...audio];
    });
    await this.mediaManager.cleanupRelativePaths(relativePaths);
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
    if (request.mode === "group") {
      const count = request.participants.length;
      if (count < 2 || count > 5) {
        throw new Error(`群聊参与者数量必须在 2 到 5 人之间，当前为 ${count} 人。`);
      }
    }

    const chat = this.repository.getChat(request.chatId);
    if (!chat) {
      throw new Error("会话不存在，请先创建会话。");
    }

    // 1. 持久化用户消息和附件
    if (request.mode === "group") {
      this.updateGroupChatRoom(request.chatId, {
        roomConfig: {
          targetRoleId: request.targetRoleId ?? request.mentionTarget ?? null,
        },
        roomState: {
          lastTargetRoleId: request.targetRoleId ?? request.mentionTarget ?? null,
        },
      });
    }

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

    return this.chatSessionService.launchGeneration(chat, request, hooks);
  }

  async editMessageAndRegenerate(
    messageId: string,
    content: string,
    hooks: ChatJobHooks = {},
  ): Promise<ChatSendResult> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      throw new Error("编辑后的消息内容不能为空。");
    }

    const message = this.repository.getMessage(messageId);
    if (!message) {
      throw new Error("消息不存在。");
    }
    if (message.role !== "user") {
      throw new Error("只有用户消息支持编辑后重生成。");
    }

    const chat = this.repository.getChat(message.chatId);
    if (!chat) {
      throw new Error("会话不存在，请先创建会话。");
    }

    const allMessages = this.repository.listMessages(chat.id);
    const targetIndex = allMessages.findIndex((entry) => entry.id === messageId);
    const removedMessages = targetIndex >= 0 ? allMessages.slice(targetIndex + 1) : [];

    this.repository.updateMessageContent(messageId, normalizedContent);
    this.repository.truncateMessagesAfter(chat.id, messageId);
    this.repository.clearMemories(chat.id);
    await this.elasticsearchService.deleteMemoriesBySession(chat.id);
    await this.cleanupMessagesMedia(removedMessages);

    return this.chatSessionService.launchGeneration(chat, {
      mode: chat.mode,
      participants: chat.participants,
      mentionTarget: chat.mentionTarget ?? null,
    }, hooks);
  }

  /**
   * 将用户上传的附件复制到 mediaDir/images/{chatId}/ 目录，
   * 返回可用于持久化到数据库的相对路径信息。
   */
}
