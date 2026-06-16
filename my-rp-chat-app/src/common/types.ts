export type ChatMode = "single" | "group";
export type MessageRole = "user" | "assistant" | "system";
export type RecordType = "dialogue" | "passage" | "memory";
export type AttachmentKind = "image" | "audio" | "file";

export interface MessageAttachment {
  id: string;
  kind: AttachmentKind;
  originalName: string;
  mimeType: string;
  size: number;
  relativePath: string;
  width?: number;
  height?: number;
  durationMs?: number;
  previewUrl?: string;
}

export interface PendingAttachmentInput {
  id: string;
  kind: AttachmentKind;
  originalName: string;
  mimeType: string;
  size: number;
  absolutePath?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  previewUrl?: string;
}

export interface MessageAudio {
  status: "pending" | "ready" | "failed";
  voiceId: string;
  relativePath?: string;
  mimeType?: string;
  durationMs?: number;
  error?: string;
}

export interface ChatMessageMetadata {
  attachments?: MessageAttachment[];
  audio?: MessageAudio;
  speechTextJa?: string;
  retrievedCount?: number;
  memoryCount?: number;
}

export interface TagCollection {
  scene?: string[];
  emotion?: string[];
  function?: string[];
  tone?: string[];
}

export interface CharacterRelationship {
  relation: string;
  attitude: string;
  closeness: number;
}

export interface CharacterPromptProfile {
  name: string;
  role: string;
  identity: string;
  personality: string[];
  selfAddress: string;
  tone: string;
  typicalExpressions: string[];
  forbiddenWords: string[];
  forbiddenStyle: string[];
  addressOthers: Record<string, string>;
  relationships: Record<string, CharacterRelationship>;
  worldKnowledge: string[];
  emotionalArc: Record<string, string>;
}

export interface CharacterProfile {
  id: string;
  name: string;
  displayName: string;
  isPlayable: boolean;
  characterType: string;
  summary: string;
  promptProfile: CharacterPromptProfile;
}

export interface ChatRecord {
  id: string;
  title: string;
  mode: ChatMode;
  participants: string[];
  mentionTarget?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  summary?: string;
  emotion?: string;
  importance?: number;
  keyPoints?: string[];
  chatId: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  roleId?: string | null;
  metadata?: ChatMessageMetadata;
}

export interface RetrievedDoc {
  sourceId: string;
  recordType: RecordType;
  character: string;
  text: string;
  score: number;
  chapter?: string;
  isPlayable?: boolean;
  tags?: TagCollection;
  sourceDialogueKeys?: string[];
}



export interface EpisodicMemory {
  id: string; chatId: string; sessionId: string; character: string;
  summary: string; emotion: string; importance: number; keyPoints: string[];
  content: string; category: string; timestamp: number; tags: string[];
  sourceMessageId?: string;
}

export interface CoreMemory {
  id: string; chatId: string; character: string;
  userPreferences: string[]; userTraits: string[];
  relationshipStage: string; relationshipNotes: string[];
  keyFacts: string[]; lastUpdated: number;
}

export interface MemoryEvent {
  id: string;
  chatId: string;
  summary?: string;
  emotion?: string;
  importance?: number;
  keyPoints?: string[];
  sessionId: string;
  character: string;
  content: string;
  category: string;
  timestamp: number;
  tags: string[];
  sourceMessageId?: string;
}

export interface RetrievalFilters {
  character?: string;
  recordType?: RecordType;
  chapter?: string;
  isPlayable?: boolean;
  sessionId?: string;
  category?: string;
  tags?: TagCollection;
  topK?: number;
}

export interface ChatRequest {
  chatId: string;
  content: string;
  mode: ChatMode;
  participants: string[];
  mentionTarget?: string | null;
  attachments?: PendingAttachmentInput[];
}

export type BackendJobType = "chat" | "index_dialogues";
export type BackendJobStatus = "pending" | "running" | "completed" | "failed";

export interface BackendJob {
  id: string;
  type: BackendJobType;
  status: BackendJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  chatId?: string;
  streamId?: string;
  error?: string;
  result?: Record<string, unknown>;
}

export interface ChatSendResult {
  jobId: string;
  streamId: string;
  streamUrl: string;
}

export interface StreamTokenPayload {
  type: "token";
  streamId: string;
  roleId?: string | null;
  token: string;
}

export interface StreamDonePayload {
  type: "message_done";
  streamId: string;
  roleId?: string | null;
  messageId?: string;
  content: string;
}

export interface StreamErrorPayload {
  type: "error";
  streamId: string;
  roleId?: string | null;
  message: string;
}

export interface StreamAudioReadyPayload {
  type: "audio_ready";
  streamId: string;
  messageId: string;
  roleId?: string | null;
  relativePath: string;
}

export interface StreamAudioFailedPayload {
  type: "audio_failed";
  streamId: string;
  messageId: string;
  roleId?: string | null;
  error: string;
}

export interface StreamStatusPayload {
  type: "status";
  streamId: string;
  roleId?: string | null;
  node: string;
  message: string;
}

export type StreamEvent =
  | StreamTokenPayload
  | StreamDonePayload
  | StreamErrorPayload
  | StreamAudioReadyPayload
  | StreamAudioFailedPayload
  | StreamStatusPayload;

export interface BootstrapPayload {
  characters: CharacterProfile[];
  chats: ChatRecord[];
  backendBaseUrl: string;
}

export interface PublicSettings {
  appName: string;
  datasetDir: string;
  llmModel: string;
  esNode: string;
  dialogueIndex: string;
  memoryIndex: string;
  esEnabled: boolean;
  mediaDir: string;
  ttsProvider: string;
  ttsEnabled: boolean;
}
