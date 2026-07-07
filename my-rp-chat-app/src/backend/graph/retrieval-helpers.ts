import type { ChatMessage } from "../../common/types";
import { findLastUserMessage } from "./graph-types";

const CHARACTER_NAME_VARIANTS: Record<string, string[]> = {
  丛雨: ["丛雨丸", "丛雨"],
  芳乃: ["朝武芳乃", "芳乃"],
  茉子: ["常陆茉子", "茉子"],
  蕾娜: ["蕾娜·列支敦瑙尔", "蕾娜"],
  将臣: ["将臣"],
};

const EXPLICIT_IMAGE_IDENTITY_PATTERN = /(我知道|我确认|这是|图里的人是|照片里的人是|这个人是|那个人是)/;
const IMAGE_IDENTITY_UNCERTAINTY_PATTERN = /(是谁|是不是|像不像|认得|认不认得|能不能确认|是否是)/;

export function buildRetrievalQuery(
  messages: ChatMessage[],
  groupContext: string | undefined,
  currentRoleId: string | undefined,
): string {
  const userMessage = findLastUserMessage(messages);
  const userContent = userMessage?.content ?? "";

  if (!groupContext || !currentRoleId) {
    return userContent;
  }

  const recentMessages = messages
    .filter((message) => message.role === "user" || message.roleId === currentRoleId)
    .slice(-6)
    .map((message) => `${message.roleId ?? "用户"}：${message.content}`)
    .join("\n");

  if (!recentMessages) {
    return userContent;
  }

  return `${userContent}\n\n=== 群聊上下文 ===\n${recentMessages}`;
}

export function stripCharacterName(query: string, characterId?: string): string {
  if (!characterId) {
    return query;
  }

  const names = CHARACTER_NAME_VARIANTS[characterId];
  if (!names?.length) {
    return query;
  }

  let stripped = query;
  for (const name of names) {
    stripped = stripped.split(name).join("");
  }

  return stripped.replace(/\s+/g, " ").trim();
}

export function hasExplicitImageIdentity(userInput: string): boolean {
  return EXPLICIT_IMAGE_IDENTITY_PATTERN.test(userInput)
    && !IMAGE_IDENTITY_UNCERTAINTY_PATTERN.test(userInput);
}
