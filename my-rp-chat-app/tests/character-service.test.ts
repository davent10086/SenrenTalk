import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/backend/config";
import { CharacterService } from "../src/backend/services/characters/character-service";
import { createTempDir, cleanupTempDirs } from "./helpers/temp-dir";

afterEach(async () => {
  await cleanupTempDirs();
});

function createConfig(datasetDir: string): AppConfig {
  return { datasetDir } as AppConfig;
}

function writeConstraints(dir: string, data: unknown): string {
  const filePath = path.join(dir, "character_constraints.json");
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

describe("CharacterService.loadCharacters", () => {
  it("loads characters from valid JSON file", async () => {
    const dir = createTempDir();
    writeConstraints(dir, {
      characters: {
        丛雨: {
          name: "丛雨",
          is_playable: true,
          character_type: "playable",
          identity: "神社的精灵",
          personality: ["温柔", "神秘"],
          speaking_style: {
            self_address: "本座",
            tone: "古风",
            typical_expressions: ["吾辈"],
          },
        },
        芳乃: {
          name: "芳乃",
          is_playable: true,
          character_type: "playable",
          identity: "巫女",
          personality: ["认真"],
          speaking_style: {
            self_address: "我",
            tone: "礼貌",
          },
        },
      },
    });

    const service = new CharacterService(createConfig(dir));
    const characters = await service.loadCharacters();

    expect(characters).toHaveLength(2);

    const congYu = characters.find((c) => c.id === "丛雨");
    expect(congYu).toBeDefined();
    expect(congYu?.name).toBe("丛雨");
    expect(congYu?.displayName).toBe("丛雨");
    expect(congYu?.isPlayable).toBe(true);
    expect(congYu?.characterType).toBe("playable");
    expect(congYu?.promptProfile.identity).toBe("神社的精灵");
    expect(congYu?.promptProfile.personality).toEqual(["温柔", "神秘"]);
    expect(congYu?.promptProfile.selfAddress).toBe("本座");
    expect(congYu?.promptProfile.tone).toBe("古风");
    expect(congYu?.promptProfile.typicalExpressions).toEqual(["吾辈"]);

    const fangNai = characters.find((c) => c.id === "芳乃");
    expect(fangNai?.promptProfile.selfAddress).toBe("我");
  });

  it("handles missing optional fields with defaults", async () => {
    const dir = createTempDir();
    writeConstraints(dir, {
      characters: {
        minimal: {
          name: "极简角色",
        },
      },
    });

    const service = new CharacterService(createConfig(dir));
    const characters = await service.loadCharacters();

    expect(characters).toHaveLength(1);
    const char = characters[0];

    expect(char.id).toBe("minimal");
    expect(char.name).toBe("极简角色");
    expect(char.displayName).toBe("极简角色");
    expect(char.isPlayable).toBe(false);
    expect(char.characterType).toBe("support");
    // 默认值
    expect(char.promptProfile.selfAddress).toBe("我");
    expect(char.promptProfile.tone).toBe("自然");
    expect(char.promptProfile.personality).toEqual([]);
    expect(char.promptProfile.typicalExpressions).toEqual([]);
    expect(char.promptProfile.forbiddenWords).toEqual([]);
    expect(char.promptProfile.forbiddenStyle).toEqual([]);
    expect(char.promptProfile.addressOthers).toEqual({});
    expect(char.promptProfile.relationships).toEqual({});
    expect(char.promptProfile.worldKnowledge).toEqual([]);
    expect(char.promptProfile.emotionalArc).toEqual({});
  });

  it("maps speaking_style fields correctly", async () => {
    const dir = createTempDir();
    writeConstraints(dir, {
      characters: {
        detailed: {
          name: "详细角色",
          identity: "测试身份",
          personality: ["性格1", "性格2"],
          speaking_style: {
            self_address: "鄙人",
            tone: "谦逊",
            typical_expressions: ["不敢当", "过奖"],
            forbidden_words: ["俺", "咱"],
            forbidden_style: ["粗鲁"],
            address_others: { 主角: "您" },
          },
          relationships: { 主角: { relation: "朋友", attitude: "敬重", closeness: 5 } },
          world_knowledge: ["世界知识1"],
          emotional_arc: { 初遇: "惊讶" },
        },
      },
    });

    const service = new CharacterService(createConfig(dir));
    const characters = await service.loadCharacters();

    expect(characters).toHaveLength(1);
    const char = characters[0];

    expect(char.promptProfile.selfAddress).toBe("鄙人");
    expect(char.promptProfile.tone).toBe("谦逊");
    expect(char.promptProfile.typicalExpressions).toEqual(["不敢当", "过奖"]);
    expect(char.promptProfile.forbiddenWords).toEqual(["俺", "咱"]);
    expect(char.promptProfile.forbiddenStyle).toEqual(["粗鲁"]);
    expect(char.promptProfile.addressOthers).toEqual({ 主角: "您" });
    expect(char.promptProfile.relationships).toEqual({
      主角: { relation: "朋友", attitude: "敬重", closeness: 5 },
    });
    expect(char.promptProfile.worldKnowledge).toEqual(["世界知识1"]);
    expect(char.promptProfile.emotionalArc).toEqual({ 初遇: "惊讶" });
  });

  it("returns empty array for empty characters object", async () => {
    const dir = createTempDir();
    writeConstraints(dir, { characters: {} });

    const service = new CharacterService(createConfig(dir));
    const characters = await service.loadCharacters();

    expect(characters).toEqual([]);
  });
});
