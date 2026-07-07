export type ChatMode = "single" | "group";
export type MessageRole = "user" | "assistant" | "system";
export type RecordType = "dialogue" | "passage" | "memory";
export type AttachmentKind = "image" | "audio" | "file";
export type GroupChatRoomMode = "single_round" | "free_chat" | "host_mode";
export type GroupChatSpeakerPolicy = "mentioned_first" | "round_robin" | "model_pick";
export type GroupChatSilencePolicy = "allow_skip" | "must_reply_if_mentioned";
export type GroupChatGenerationReason =
  | "mentioned"
  | "scheduled"
  | "nominated"
  | "host_prompted"
  | "retry_rewrite"
  | "skipped";
export type GroupChatSkipReason =
  | "no_new_value"
  | "similar_to_last"
  | "not_addressed"
  | "budget_exhausted";

export interface GroupChatRoomConfig {
  mode: GroupChatRoomMode;
  topic?: string;
  scene?: string;
  targetRoleId?: string | null;
  maxRounds: number;
  maxMessages: number;
  speakerPolicy: GroupChatSpeakerPolicy;
  silencePolicy: GroupChatSilencePolicy;
  hostRoleId?: string | null;
}

export interface GroupChatRoomState {
  currentRound: number;
  currentTurn: number;
  plannedSpeakers: string[];
  lastSpeakers: string[];
  skippedRoles: Array<{ roleId: string; reason: GroupChatSkipReason }>;
  lastFinishedReason?: string;
  topic?: string;
  consensus?: string[];
  unresolved?: string[];
  mood?: string;
  lastTargetRoleId?: string | null;
}

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
  replyToMessageId?: string;
  replyToRoleId?: string;
  round?: number;
  turnIndex?: number;
  generationReason?: GroupChatGenerationReason;
  skipReason?: GroupChatSkipReason;
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
  roomConfig?: GroupChatRoomConfig;
  roomState?: GroupChatRoomState;
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
  contextBefore?: string;
  contextAfter?: string;
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
  targetRoleId?: string | null;
  attachments?: PendingAttachmentInput[];
}

export interface CreateChatRequest {
  mode: ChatMode;
  participants: string[];
  title?: string;
  roomConfig?: Partial<GroupChatRoomConfig>;
}

export interface UpdateGroupChatRoomRequest {
  roomConfig?: Partial<GroupChatRoomConfig>;
  roomState?: Partial<GroupChatRoomState>;
}

export type BackendJobType = "chat" | "index_dialogues";
export type BackendJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BackendJobProgress {
  current: number;
  total?: number;
  stage?: string;
  percent?: number;
}

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
  durationMs?: number;
  progress?: BackendJobProgress;
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

export interface StreamRoundStatsPayload {
  type: "round_stats";
  streamId: string;
  round: number;
  generatedCount: number;
  speakers: string[];
  skipped: string[];
  failed: string[];
  durationMs: number;
}

export interface StreamRoundStartedPayload {
  type: "round_started";
  streamId: string;
  round: number;
  mode: GroupChatRoomMode;
  targetRoleId?: string | null;
}

export interface StreamRoundPlanPayload {
  type: "round_plan";
  streamId: string;
  round: number;
  plannedSpeakers: string[];
  mode: GroupChatRoomMode;
  targetRoleId?: string | null;
}

export interface StreamRoomFinishedPayload {
  type: "room_finished";
  streamId: string;
  reason: string;
  round: number;
  generatedCount: number;
}

export interface StreamRoleSkippedPayload {
  type: "role_skipped";
  streamId: string;
  roleId: string;
  round: number;
  reason: GroupChatSkipReason;
  message: string;
}

export type StreamEvent =
  | StreamTokenPayload
  | StreamDonePayload
  | StreamErrorPayload
  | StreamAudioReadyPayload
  | StreamAudioFailedPayload
  | StreamStatusPayload
  | StreamRoundStatsPayload
  | StreamRoundStartedPayload
  | StreamRoundPlanPayload
  | StreamRoomFinishedPayload
  | StreamRoleSkippedPayload;

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

export function createDefaultGroupChatRoomConfig(participantCount: number): GroupChatRoomConfig {
  return {
    mode: "single_round",
    topic: "",
    scene: "",
    targetRoleId: null,
    maxRounds: 1,
    maxMessages: Math.max(1, participantCount),
    speakerPolicy: "mentioned_first",
    silencePolicy: "must_reply_if_mentioned",
    hostRoleId: null,
  };
}

export function createDefaultGroupChatRoomState(
  roomConfig?: Partial<GroupChatRoomConfig>,
): GroupChatRoomState {
  return {
    currentRound: 0,
    currentTurn: 0,
    plannedSpeakers: [],
    lastSpeakers: [],
    skippedRoles: [],
    lastFinishedReason: undefined,
    topic: roomConfig?.topic ?? "",
    consensus: [],
    unresolved: [],
    mood: "",
    lastTargetRoleId: roomConfig?.targetRoleId ?? null,
  };
}
