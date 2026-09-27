/** Multi-modal image input passed through the OpenAI-compatible client. */
export interface ImageInput {
  mimeType: string;
  base64: string;
}

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  onToken: (token: string) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface StructuredCompletionRequest extends CompletionRequest {
  images?: ImageInput[];
}

export interface StructuredCompletionResult {
  content: string;
  speechTextJa: string;
  nextSpeaker?: string;
  skip?: boolean;
  raw: string;
}

export interface ImageIdentityCandidate {
  canonicalName: string;
  identity: string;
}

export interface SpeechTextRequest {
  characterName: string;
  selfAddress: string;
  content: string;
}
