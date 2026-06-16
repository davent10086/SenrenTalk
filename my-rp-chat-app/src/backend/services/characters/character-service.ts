import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config";
import type { CharacterProfile } from "../../../common/types";

interface ConstraintFile {
  characters: Record<string, Record<string, unknown>>;
}

/**
 * 角色服务，负责加载和管理角色配置数据。
 */
export class CharacterService {
  /**
   * @param config 应用程序配置对象
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * 从数据集目录加载角色约束配置文件，解析并返回角色列表。
   * @returns 角色配置列表
   */
  async loadCharacters(): Promise<CharacterProfile[]> {
    const filePath = path.join(this.config.datasetDir, "character_constraints.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ConstraintFile;

    return Object.entries(parsed.characters).map(([id, value]) => {
      const speakingStyle = (value.speaking_style ?? {}) as Record<string, unknown>;
      const personality = Array.isArray(value.personality) ? value.personality.map((item) => String(item)) : [];
      return {
        id,
        name: String(value.name ?? id),
        displayName: String(value.name ?? id),
        isPlayable: Boolean(value.is_playable),
        characterType: String(value.character_type ?? "support"),
        summary: `${String(value.identity ?? "")}${personality.length > 0 ? `；${personality.slice(0, 2).join("，")}` : ""}`,
        promptProfile: {
          name: String(value.name ?? id),
          role: String(value.role ?? ""),
          identity: String(value.identity ?? ""),
          personality,
          selfAddress: String(speakingStyle.self_address ?? "我"),
          tone: String(speakingStyle.tone ?? "自然"),
          typicalExpressions: Array.isArray(speakingStyle.typical_expressions)
            ? speakingStyle.typical_expressions.map((item) => String(item))
            : [],
          forbiddenWords: Array.isArray(speakingStyle.forbidden_words)
            ? speakingStyle.forbidden_words.map((item) => String(item))
            : [],
          forbiddenStyle: Array.isArray(speakingStyle.forbidden_style)
            ? speakingStyle.forbidden_style.map((item) => String(item))
            : [],
          addressOthers: ((speakingStyle.address_others ?? {}) as Record<string, string>),
          relationships: ((value.relationships ?? {}) as CharacterProfile["promptProfile"]["relationships"]),
          worldKnowledge: Array.isArray(value.world_knowledge) ? value.world_knowledge.map((item) => String(item)) : [],
          emotionalArc: ((value.emotional_arc ?? {}) as Record<string, string>),
        },
      } satisfies CharacterProfile;
    });
  }
}
