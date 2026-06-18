import type {
  CharacterProfile,
  ChatMessage,
  MemoryEvent,
  RetrievedDoc,
} from "../../src/common/types";

/**
 * 测试数据工厂：集中管理测试用例的数据构造，消除跨文件重复定义。
 * 所有工厂均支持 partial overrides，便于在用例中只覆盖关键字段。
 */

export function createCharacter(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  const id = overrides.id ?? "丛雨";
  return {
    id,
    name: id,
    displayName: id,
    isPlayable: true,
    characterType: "playable",
    summary: `${id} summary`,
    promptProfile: {
      name: id,
      role: "heroine",
      identity: `${id} identity`,
      personality: ["gentle"],
      selfAddress: id === "丛雨" ? "本座" : "我",
      tone: "温柔",
      typicalExpressions: ["你好"],
      forbiddenWords: [],
      forbiddenStyle: [],
      addressOthers: {},
      relationships: {},
      worldKnowledge: [],
      emotionalArc: {},
    },
    ...overrides,
  };
}

export function createChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    chatId: "chat-1",
    role: "user",
    content: "你好",
    timestamp: Date.now(),
    ...overrides,
  };
}

export function createMemoryEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "mem-1",
    chatId: "chat-1",
    sessionId: "chat-1",
    character: "丛雨",
    content: "用户喜欢晴天",
    category: "preference",
    timestamp: Date.now(),
    tags: ["weather"],
    importance: 5,
    ...overrides,
  };
}

export function createRetrievedDoc(overrides: Partial<RetrievedDoc> = {}): RetrievedDoc {
  return {
    sourceId: "dlg_001",
    recordType: "dialogue",
    character: "丛雨",
    text: "今天天气真好",
    score: 0.9,
    tags: { scene: ["outdoor"], emotion: ["happy"], function: ["greeting"] },
    ...overrides,
  };
}

/** 从系统提示词中提取角色自称，用于生成能通过 validate_response 的回复内容。 */
export function extractSelfAddress(systemPrompt: string): string {
  const match = systemPrompt.match(/必须自称：(.+)/);
  return match ? match[1].trim() : "我";
}
