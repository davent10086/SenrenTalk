import { Annotation } from "@langchain/langgraph";
import type {
  CharacterProfile,
  ChatMessage,
  ChatMode,
  GroupChatGenerationReason,
  GroupChatRoomConfig,
  GroupChatSkipReason,
  RetrievedDoc,
  TagCollection,
} from "../../common/types";
import { ChatRepository } from "../db/database";
import { CharacterService } from "../services/characters/character-service";
import { ElasticsearchService } from "../services/es/elasticsearch-service";
import { LlmService, type ImageInput } from "../services/llm/llm-service";
import { MemoryService } from "../services/memory/memory-service";
import { SseService } from "../services/stream/sse-service";
import { TtsService } from "../services/tts/tts-service";

export const ChatState = Annotation.Root({
  chatId: Annotation<string>(),
  streamId: Annotation<string>(),
  mode: Annotation<ChatMode>(),
  participants: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  mentionTarget: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  activeRoleIndex: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  currentRoleId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  messages: Annotation<ChatMessage[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  retrievedDocs: Annotation<RetrievedDoc[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  memories: Annotation<RetrievedDoc[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  summary: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  prompt: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  output: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  speechTextJa: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  retryCount: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  validationIssue: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  character: Annotation<CharacterProfile | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  nextSpeaker: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  skip: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  coreMemory: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  groupContext: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  extractedTags: Annotation<TagCollection>({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),
  retrievalQuery: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  roomConfig: Annotation<GroupChatRoomConfig | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  currentRound: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  turnIndex: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  replyToMessageId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  replyToRoleId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  generationReason: Annotation<GroupChatGenerationReason | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  skipReason: Annotation<GroupChatSkipReason | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  antiRepeatInstruction: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
});

export type ChatGraphState = typeof ChatState.State;

export interface GraphDependencies {
  repository: ChatRepository;
  characterService: CharacterService;
  elasticsearchService: ElasticsearchService;
  llmService: LlmService;
  memoryService: MemoryService;
  sseService: SseService;
  ttsService?: TtsService;
  readImageAsBase64?: (relativePath: string) => Promise<ImageInput | null>;
  trackAsyncJob?: (job: Promise<unknown>) => void;
  abortSignal?: AbortSignal;
}

export function ensureNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("消息生成已中断");
  error.name = "AbortError";
  throw error;
}

export function findLastUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index];
    }
  }
  return undefined;
}
