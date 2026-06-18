import OpenAI from "openai";
import type { AppConfig } from "../../config";

/**
 * 标准补全请求参数，用于流式调用 LLM 生成回复。
 */
export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  onToken: (token: string) => Promise<void> | void;
}

/**
 * 结构化补全请求参数，继承自 {@link CompletionRequest}，要求 LLM 以 JSON 格式输出。
 */
export interface StructuredCompletionRequest extends CompletionRequest {}

/**
 * 结构化补全结果，包含中文展示内容、日语朗读稿、可选的下一说话人及跳过标志。
 */
export interface StructuredCompletionResult {
  content: string;
  speechTextJa: string;
  nextSpeaker?: string;
  /** 群聊下 agent 可自愿跳过本次发言，此时 content/speechTextJa 为空。 */
  skip?: boolean;
  raw: string;
}

/**
 * 日语朗读稿生成请求参数。
 */
export interface SpeechTextRequest {
  characterName: string;
  selfAddress: string;
  content: string;
}

/**
 * 从原始 JSON 文本中提取字符串字段的中间结果。
 */
interface JsonStringFieldResult {
  value: string;
  complete: boolean;
}

/**
 * DeepSeek LLM 服务封装，提供流式补全、结构化输出及日语朗读稿生成等能力。
 */
export class DeepSeekService {
  private readonly client: OpenAI;

  /**
   * @param config - 应用配置，包含 DeepSeek API Key、Base URL 及模型名称。
   */
  constructor(private readonly config: AppConfig) {
    this.client = new OpenAI({
      apiKey: config.deepseekApiKey,
      baseURL: config.deepseekBaseUrl,
    });
  }

  /**
   * 流式调用 DeepSeek LLM，逐 token 回调并返回完整回复文本。
   * @param request - 补全请求，包含系统提示词、用户提示词及 token 回调。
   * @returns 完整的回复文本。
   * @throws 如果未配置 DEEPSEEK_API_KEY 则抛出错误。
   */
  async streamCompletion(request: CompletionRequest): Promise<string> {
    if (!this.config.deepseekApiKey) {
      throw new Error("缺少 DEEPSEEK_API_KEY，无法调用 DeepSeek 流式接口。");
    }

    const stream = await this.client.chat.completions.create({
      model: this.config.deepseekModel,
      stream: true,
      temperature: 0.8,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt },
      ],
    });

    let fullText = "";
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (!token) {
        continue;
      }
      fullText += token;
      await request.onToken(token);
    }
    return fullText;
  }

  /**
   * 流式调用 DeepSeek LLM 并要求以 JSON 格式输出，同时将 content 字段增量推送给回调。
   * @param request - 结构化补全请求。
   * @returns 解析后的结构化结果，包含 content、speechTextJa 及可选的 nextSpeaker。
   * @throws 如果未配置 DEEPSEEK_API_KEY 则抛出错误。
   */
  async streamStructuredCompletion(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResult> {
    if (!this.config.deepseekApiKey) {
      throw new Error("缺少 DEEPSEEK_API_KEY，无法调用 DeepSeek 流式接口。");
    }

    const stream = await this.client.chat.completions.create({
      model: this.config.deepseekModel,
      stream: true,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: [
            request.systemPrompt,
            "你必须严格输出单个 JSON 对象，不能输出任何额外解释、前后缀、代码块或 Markdown。",
            "{\"content\":\"中文回复\",\"speechTextJa\":\"日语朗读稿\"}",
            "要求：",
            "1. content 使用自然中文，适合界面展示。",
            "2. speechTextJa 使用自然日语口语，适合 TTS 朗读。",
            "3. 两个字段必须语义一致，保持同一角色口吻。",
            "4. JSON 的第一个键必须是 content，并尽快开始输出 content 的正文。",
          ].join("\n\n"),
        },
        { role: "user", content: request.userPrompt },
      ],
    });

    let raw = "";
    let streamedContent = "";

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (!token) {
        continue;
      }

      raw += token;
      const nextContent = extractPartialJsonStringField(raw, "content").value;
      if (nextContent.length > streamedContent.length) {
        const delta = nextContent.slice(streamedContent.length);
        streamedContent = nextContent;
        await request.onToken(delta);
      }
    }

    const parsed = parseStructuredResponse(raw);
    return {
      content: parsed.content || streamedContent || raw.trim(),
      speechTextJa: parsed.speechTextJa,
      nextSpeaker: parsed.nextSpeaker,
      skip: parsed.skip,
      raw,
    };
  }

  /**
   * 将中文回复改写为适合日语 TTS 朗读的自然口语文本。
   * @param request - 包含角色名、角色自称及待改写的中文内容。
   * @returns 日语朗读稿文本。
   * @throws 如果未配置 DEEPSEEK_API_KEY 则抛出错误。
   */
  async generateSpeechTextJa(request: SpeechTextRequest): Promise<string> {
    if (!this.config.deepseekApiKey) {
      throw new Error("缺少 DEEPSEEK_API_KEY，无法生成日语朗读稿。");
    }

    const response = await this.client.chat.completions.create({
      model: this.config.deepseekModel,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: [
            `你是角色扮演文案助手，需要把中文回复改写成适合日语 TTS 的自然口语。`,
            `角色名：${request.characterName}`,
            `角色自称：${request.selfAddress}`,
            "输出必须是纯日语台词，不要解释，不要加 JSON，不要加引号。",
            "要保留角色口吻、称呼关系和情绪，但避免书面翻译腔。",
            "忽略括号内的动作描写、舞台指示、心理活动等非台词内容，只改写实际说出口的话。",
          ].join("\n"),
        },
        {
          role: "user",
          content: `请把下面这句中文回复改写为自然日语朗读稿：\n${request.content}`,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? "";
  }

  /**
   * 从一轮对话中提取情景记忆摘要、情绪、重要度及关键要点。
   * @param input - 包含角色名、用户输入和助手输出。
   * @returns 解析后的记忆数据。
   */
  async extractEpisodicMemory(input: { characterName: string; userInput: string; assistantOutput: string }): Promise<{ summary: string; emotion: string; importance: number; keyPoints: string[] }> {
    const response = await this.client.chat.completions.create({
      model: this.config.deepseekModel,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: [
            `你是记忆分析师，负责从角色扮演对话中提取情景记忆。角色名：${input.characterName}`,
            `请严格输出以下 JSON 格式：`,
            `{"summary": "一句话概括这次交互的核心内容（不超过100字）", "emotion": "角色在这轮对话中的情绪标签（如：开心、悲伤、愤怒、平静、害羞等）", "importance": 数字1-10表示这段记忆的重要性, "keyPoints": ["关键信息点1", "关键信息点2"]}`,
            `注意：只输出 JSON，不要加任何额外解释或 Markdown 标记。`,
          ].join("\n"),
        },
        { role: "user", content: `用户说：${input.userInput}\n角色回复：${input.assistantOutput}` },
      ],
    });
    try {
      const raw = response.choices[0]?.message?.content ?? "{}";
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) {
        return { summary: input.assistantOutput.slice(0, 100), emotion: "平静", importance: 3, keyPoints: [] };
      }
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : input.assistantOutput.slice(0, 100),
        emotion: typeof parsed.emotion === "string" ? parsed.emotion : "平静",
        importance: typeof parsed.importance === "number" ? parsed.importance : 3,
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.filter((v): v is string => typeof v === "string") : [],
      };
    } catch {
      return { summary: input.assistantOutput.slice(0, 100), emotion: "平静", importance: 3, keyPoints: [] };
    }
  }

  /**
   * 根据最近记忆分析并整合核心记忆，包括用户偏好、特质、关系阶段等。
   * @param input - 包含角色名、当前核心记忆及最近记忆列表。
   * @returns 整合后的核心记忆数据。
   */
  async consolidateCoreMemory(input: { characterName: string; currentCore: string; recentMemories: string[] }): Promise<{ userPreferences: string[]; userTraits: string[]; relationshipStage: string; relationshipNotes: string[]; keyFacts: string[] }> {
    const response = await this.client.chat.completions.create({
      model: this.config.deepseekModel,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: [
            `你是关系分析师，负责从角色扮演对话记忆中提炼用户画像与关系状态。`,
            `当前分析的角色：${input.characterName}`,
            `当前已有的核心记忆：\n${input.currentCore}`,
            ``,
            `请基于最近记忆，整合并更新核心记忆。严格输出以下 JSON 格式：`,
            `{"userPreferences": ["用户偏好1", "用户偏好2"], "userTraits": ["用户性格特质1"], "relationshipStage": "当前关系阶段描述", "relationshipNotes": ["关系备注1"], "keyFacts": ["关键事实1"]}`,
            ``,
            `要求：`,
            `1. userPreferences：用户的喜好、习惯、偏好。`,
            `2. userTraits：用户的性格特质。`,
            `3. relationshipStage：${input.characterName}与用户当前的关系阶段（如初识、熟悉、亲密等）。`,
            `4. relationshipNotes：关系中值得记住的备注。`,
            `5. keyFacts：其他需要长期记住的关键事实。`,
            `6. 与已有核心记忆合并，保留有效信息，补充新信息，避免重复。`,
            `7. 只输出 JSON，不要加任何额外解释或 Markdown 标记。`,
          ].join("\n"),
        },
        {
          role: "user",
          content: `以下是最近的对话记忆，请据此整合核心记忆：\n${input.recentMemories.join("\n")}`,
        },
      ],
    });
    try {
      const raw = response.choices[0]?.message?.content ?? "{}";
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) {
        return { userPreferences: [], userTraits: [], relationshipStage: "", relationshipNotes: [], keyFacts: [] };
      }
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      return {
        userPreferences: Array.isArray(parsed.userPreferences) ? parsed.userPreferences.filter((v): v is string => typeof v === "string") : [],
        userTraits: Array.isArray(parsed.userTraits) ? parsed.userTraits.filter((v): v is string => typeof v === "string") : [],
        relationshipStage: typeof parsed.relationshipStage === "string" ? parsed.relationshipStage : "",
        relationshipNotes: Array.isArray(parsed.relationshipNotes) ? parsed.relationshipNotes.filter((v): v is string => typeof v === "string") : [],
        keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.filter((v): v is string => typeof v === "string") : [],
      };
    } catch {
      return { userPreferences: [], userTraits: [], relationshipStage: "", relationshipNotes: [], keyFacts: [] };
    }
  }

  /** 可提取的意图标签词表（排除高频无区分度标签）。 */
  private static readonly TAG_VOCAB = {
    emotion: ["困惑惊讶", "高兴得意", "担忧焦虑", "害羞尴尬", "生气不满", "悲伤难过"],
    function: ["答疑解惑", "拒绝否认", "请求提议", "命令指示", "争论反驳", "道谢道歉", "表达好感", "设定说明", "安慰关心", "开玩笑", "抱怨吐槽"],
    tone: ["古风", "礼貌正式", "随意"],
  } as const;

  /**
   * 从用户消息中提取意图标签，用于辅助检索。
   * 只从预定义词表中选择，每类最多 2 个，无则输出空数组。
   * @param userMessage - 用户输入的消息文本。
   * @returns 提取出的标签集合，按 emotion/function/tone 分类。
   */
  async extractTags(userMessage: string): Promise<{ emotion: string[]; function: string[]; tone: string[] }> {
    if (!this.config.deepseekApiKey) {
      return { emotion: [], function: [], tone: [] };
    }

    const vocab = DeepSeekService.TAG_VOCAB;
    const vocabDesc = [
      `emotion: [${vocab.emotion.join(", ")}]`,
      `function: [${vocab.function.join(", ")}]`,
      `tone: [${vocab.tone.join(", ")}]`,
    ].join("\n");

    const response = await this.client.chat.completions.create({
      model: this.config.deepseekModel,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "你是一个意图标签提取器。从用户消息中提取意图标签，只能从以下词表中选择，每类最多2个，无则输出空数组。",
            vocabDesc,
            "严格输出JSON，不要加任何解释或Markdown标记。",
            '{"emotion":[],"function":[],"tone":[]}',
          ].join("\n"),
        },
        { role: "user", content: userMessage },
      ],
    });

    try {
      const raw = response.choices[0]?.message?.content ?? "{}";
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) {
        return { emotion: [], function: [], tone: [] };
      }
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      const validate = (arr: unknown, vocab: readonly string[]): string[] => {
        if (!Array.isArray(arr)) return [];
        return arr.filter((v): v is string => typeof v === "string" && vocab.includes(v)).slice(0, 2);
      };
      return {
        emotion: validate(parsed.emotion, vocab.emotion),
        function: validate(parsed.function, vocab.function),
        tone: validate(parsed.tone, vocab.tone),
      };
    } catch {
      return { emotion: [], function: [], tone: [] };
    }
  }

  /**
   * 对最近的对话消息生成简短摘要。
   * @param input - 包含角色名及最近消息文本。
   * @returns 摘要字符串，最大长度 100 字符。
   */
  async generateConversationSummary(input: { characterName: string; recentMessages: string }): Promise<string> {
    const response = await this.client.chat.completions.create({ model: this.config.deepseekModel, temperature: 0.3, messages: [
      { role: "system", content: `摘要助手。角色名：`+input.characterName+`\n摘要：` }, { role: "user", content: `概括：\n`+input.recentMessages },
    ] });
    return response.choices[0]?.message?.content?.trim().slice(0, 100) ?? "暂无摘要";
  }
}

/**
 * 解析 LLM 返回的原始文本中的结构化 JSON 数据。
 * 优先尝试完整 JSON 解析，失败则通过逐字段提取降级处理。
 * @param raw - LLM 返回的原始文本。
 * @returns 解析出的 content、speechTextJa、可选的 nextSpeaker 及 skip 标志。
 */
function parseStructuredResponse(raw: string): { content: string; speechTextJa: string; nextSpeaker?: string; skip?: boolean } {
  const normalized = normalizeStructuredJson(raw);
  if (normalized) {
    try {
      const parsed = JSON.parse(normalized) as {
        content?: unknown;
        speechTextJa?: unknown;
        nextSpeaker?: unknown;
        skip?: unknown;
      };
      return {
        content: typeof parsed.content === "string" ? parsed.content.trim() : "",
        speechTextJa: typeof parsed.speechTextJa === "string" ? parsed.speechTextJa.trim() : "",
        nextSpeaker: typeof parsed.nextSpeaker === "string" ? parsed.nextSpeaker.trim() : undefined,
        skip: typeof parsed.skip === "boolean" ? parsed.skip : undefined,
      };
    } catch {
      // Fall through to tolerant field parsing.
    }
  }

  const content = extractPartialJsonStringField(raw, "content");
  const speechTextJa = extractPartialJsonStringField(raw, "speechTextJa");
  return {
    content: content.complete ? content.value.trim() : content.value,
    speechTextJa: speechTextJa.complete ? speechTextJa.value.trim() : speechTextJa.value,
  };
}

/**
 * 从原始文本中提取最外层 JSON 对象字符串。
 * 会先去除 Markdown 代码块标记（```json ... ```），再截取首尾大括号之间的内容。
 * @param raw - 包含 JSON 的原始文本。
 * @returns 提取出的 JSON 字符串，如果找不到有效对象则返回 undefined。
 */
function normalizeStructuredJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return withoutFence.slice(start, end + 1);
}

/**
 * 从可能不完整的 JSON 字符串中提取指定字段的字符串值。
 * 支持流式场景下的增量解析——即使 JSON 尚未闭合，也能读取已输出的字段内容。
 * @param raw - 可能不完整的 JSON 原始文本。
 * @param fieldName - 要提取的字段名。
 * @returns 包含字段值和完整性标志的结果对象。
 */
function extractPartialJsonStringField(raw: string, fieldName: string): JsonStringFieldResult {
  const keyIndex = raw.indexOf(`"${fieldName}"`);
  if (keyIndex < 0) {
    return { value: "", complete: false };
  }

  let cursor = keyIndex + fieldName.length + 2;
  while (cursor < raw.length && /\s/.test(raw[cursor] ?? "")) {
    cursor += 1;
  }
  if (raw[cursor] !== ":") {
    return { value: "", complete: false };
  }
  cursor += 1;

  while (cursor < raw.length && /\s/.test(raw[cursor] ?? "")) {
    cursor += 1;
  }
  if (raw[cursor] !== "\"") {
    return { value: "", complete: false };
  }

  return readJsonString(raw, cursor + 1);
}

/**
 * 从指定位置开始读取 JSON 字符串值，处理转义字符，直到遇到未转义的双引号或到达文本末尾。
 * @param raw - 原始文本。
 * @param startIndex - 字符串内容的起始位置（即开始双引号之后的下一个字符索引）。
 * @returns 包含解码后字符串值和完整性标志的结果。
 */
function readJsonString(raw: string, startIndex: number): JsonStringFieldResult {
  let value = "";
  let index = startIndex;

  while (index < raw.length) {
    const char = raw[index];
    if (char === "\"") {
      return { value, complete: true };
    }
    if (char === "\\") {
      const next = raw[index + 1];
      if (!next) {
        return { value, complete: false };
      }
      if (next === "u") {
        const hex = raw.slice(index + 2, index + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { value, complete: false };
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      const decoded = decodeJsonEscape(next);
      if (decoded === undefined) {
        value += next;
      } else {
        value += decoded;
      }
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }

  return { value, complete: false };
}

/**
 * 将 JSON 转义字符解码为对应的原始字符。
 * 支持常见转义序列：\\\" \\\\ \\/ \\b \\f \\n \\r \\t。
 * @param char - 紧跟在反斜杠后的转义字符。
 * @returns 解码后的字符，若无法识别则返回 undefined。
 */
function decodeJsonEscape(char: string): string | undefined {
  switch (char) {
    case "\"":
      return "\"";
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return undefined;
  }
}

export const __internal = {
  extractPartialJsonStringField,
  normalizeStructuredJson,
  parseStructuredResponse,
};
