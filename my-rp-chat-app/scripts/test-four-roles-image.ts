import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppConfig } from "../src/backend/config";
import { ChatRepository } from "../src/backend/db/database";
import { createSingleChatGraph } from "../src/backend/graph/chat-graphs";
import { CharacterService } from "../src/backend/services/characters/character-service";
import { LlmService, type ImageInput } from "../src/backend/services/llm/llm-service";
import type { CharacterProfile, ChatMessage } from "../src/common/types";

function readImageFromFile(filePath: string): ImageInput {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType =
    ext === ".png" ? "image/png"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : "image/jpeg";
  return { mimeType, base64: buffer.toString("base64") };
}

function buildInitialState(chatId: string, roleId: string, messages: ChatMessage[]) {
  return {
    chatId,
    streamId: `stream-${roleId}`,
    mode: "single" as const,
    participants: [roleId],
    mentionTarget: null,
    activeRoleIndex: 0,
    currentRoleId: roleId,
    messages,
    retrievedDocs: [],
    memories: [],
    summary: undefined,
    prompt: "",
    output: "",
    speechTextJa: "",
    retryCount: 0,
    validationIssue: undefined,
    character: undefined,
    nextSpeaker: undefined,
    skip: false,
    coreMemory: undefined,
    groupContext: undefined,
    extractedTags: {},
    retrievalQuery: "",
  };
}

async function main(): Promise<void> {
  const imagePath = process.argv[2] ?? "F:\\Yoshino.jpg";
  const config = createAppConfig(process.cwd(), process.cwd());

  if (!config.llmApiKey) {
    console.error("❌ 未配置 LLM_API_KEY，请先在 .env 中设置。");
    process.exit(1);
  }

  if (!fs.existsSync(imagePath)) {
    console.error(`❌ 图片不存在：${imagePath}`);
    process.exit(1);
  }

  const image = readImageFromFile(imagePath);
  const llm = new LlmService(config);
  const characterService = new CharacterService(config);
  const characters = await characterService.loadCharacters();
  const playableIds = ["丛雨", "芳乃", "茉子", "蕾娜"];
  const selectedCharacters = playableIds
    .map((id) => characters.find((character) => character.id === id))
    .filter((character): character is CharacterProfile => Boolean(character));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "senren-four-role-image-"));
  const repository = new ChatRepository(path.join(tempDir, "test.sqlite"));
  repository.init();
  repository.upsertCharacters(characters);

  console.log(`🖼️ 测试图片：${imagePath}`);
  console.log(`🤖 视觉模型：${config.llmVisionModel}`);
  console.log(`🧪 角色数：${selectedCharacters.length}`);

  for (const character of selectedCharacters) {
    const chat = repository.createChat("single", [character.id], `${character.displayName} 图片识别测试`);
    repository.appendMessage({
      chatId: chat.id,
      role: "user",
      content: "你看看这张图片里的人是谁？你认识她吗？",
      metadata: {
        attachments: [
          {
            id: "test-image",
            kind: "image",
            originalName: path.basename(imagePath),
            mimeType: image.mimeType,
            size: Buffer.from(image.base64, "base64").length,
            relativePath: "__test_image__",
          },
        ],
      },
    });

    const graph = createSingleChatGraph({
      repository,
      characterService: {} as never,
      elasticsearchService: {
        hybridSearch: async () => [],
      } as never,
      llmService: llm,
      memoryService: {
        recall: async () => [],
        getSummary: () => undefined,
        getCoreMemory: () => undefined,
        consolidateCoreMemory: async () => null,
        extractAndPersist: async () => null,
      } as never,
      sseService: {
        publish: () => {},
      } as never,
      readImageAsBase64: async (relativePath: string) => {
        if (relativePath === "__test_image__") {
          return image;
        }
        return null;
      },
    });

    const result = await graph.invoke(
      buildInitialState(chat.id, character.id, repository.listMessages(chat.id)),
      { recursionLimit: 100 },
    );

    console.log(`\n=== ${character.displayName} ===`);
    console.log(`content: ${result.output}`);
    console.log(`speechTextJa: ${result.speechTextJa}`);
  }

  repository.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("\n❌ 测试失败：", error);
  process.exit(1);
});
