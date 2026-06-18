import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

/**
 * 应用程序配置接口，包含所有运行所需的环境配置项。
 */
export interface AppConfig {
  appName: string;
  appRoot: string;
  workspaceRoot: string;
  datasetDir: string;
  sqlitePath: string;
  mediaDir: string;
  embeddingDimensions: number;
  ollamaHost: string;
  ollamaModelName: string;
  deepseekApiKey?: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  esNode: string;
  esUsername: string;
  esPassword: string;
  esDialogueIndex: string;
  esMemoryIndex: string;
  esRejectUnauthorized: boolean;
  topK: number;
  ttsProvider: string;
  ttsApiKey?: string;
  ttsBaseUrl?: string;
  ttsModel?: string;
  ttsDefaultVoice?: string;
  ttsCharacterVoiceMap: Record<string, string>;
  langsmithTracing: boolean;
  langsmithApiKey?: string;
  langsmithProject: string;
  langsmithEndpoint: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function parseJsonRecord(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/**
 * 创建应用程序配置对象，从环境变量中读取各项配置。
 * @param appRoot 应用根目录路径
 * @param userDataPath 用户数据目录路径
 * @returns 解析后的应用配置对象
 */
export function createAppConfig(appRoot: string, userDataPath: string): AppConfig {
  const workspaceRoot = path.resolve(appRoot, "..");
  return {
    appName: "SenrenTalk",
    appRoot,
    workspaceRoot,
    datasetDir: process.env.DATASET_DIR
      ? path.resolve(appRoot, process.env.DATASET_DIR)
      : path.join(workspaceRoot, "索引数据"),
    sqlitePath: process.env.SQLITE_PATH
      ? path.resolve(process.env.SQLITE_PATH)
      : path.join(userDataPath, "senren-talk.sqlite"),
    mediaDir: process.env.MEDIA_DIR
      ? path.resolve(process.env.MEDIA_DIR)
      : path.join(userDataPath, "media"),
    embeddingDimensions: Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? "1024", 10),
    ollamaHost: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    ollamaModelName: process.env.OLLAMA_MODEL_NAME ?? "bge-m3:latest",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    esNode: process.env.ES_NODE ?? "https://127.0.0.1:9200/",
    esUsername: process.env.ES_USERNAME ?? "elastic",
    esPassword: process.env.ES_PASSWORD ?? "",
    esDialogueIndex: process.env.ES_DIALOGUE_INDEX ?? "senren_dialogues",
    esMemoryIndex: process.env.ES_MEMORY_INDEX ?? "senren_memories",
    esRejectUnauthorized: parseBoolean(process.env.ES_TLS_REJECT_UNAUTHORIZED, true),
    topK: Number.parseInt(process.env.TOP_K ?? "8", 10),
    ttsProvider: process.env.TTS_PROVIDER ?? "disabled",
    ttsApiKey: process.env.TTS_API_KEY,
    ttsBaseUrl: process.env.TTS_BASE_URL,
    ttsModel: process.env.TTS_MODEL,
    ttsDefaultVoice: process.env.TTS_DEFAULT_VOICE,
    ttsCharacterVoiceMap: parseJsonRecord(process.env.TTS_CHARACTER_VOICE_MAP),
    langsmithTracing: parseBoolean(process.env.LANGSMITH_TRACING, false),
    langsmithApiKey: process.env.LANGSMITH_API_KEY,
    langsmithProject: process.env.LANGSMITH_PROJECT ?? "senren-talk",
    langsmithEndpoint: process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
  };
}
