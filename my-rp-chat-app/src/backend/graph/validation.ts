import type { CharacterProfile } from "../../common/types";
import { ChatRepository } from "../db/database";
import type { ChatGraphState } from "./graph-types";
import { findLastUserMessage } from "./graph-types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMentionedCharacters(
  userInput: string,
  currentRoleId: string | undefined,
  allCharacters: CharacterProfile[],
): CharacterProfile[] {
  return allCharacters.filter((character) => {
    if (character.id === currentRoleId) {
      return false;
    }
    return userInput.includes(character.name) || userInput.includes(character.displayName);
  });
}

const KINSHIP_PATTERNS = [
  { label: "父亲", aliases: ["父亲", "爸爸"] },
  { label: "母亲", aliases: ["母亲", "妈妈"] },
  { label: "哥哥", aliases: ["哥哥"] },
  { label: "姐姐", aliases: ["姐姐"] },
  { label: "弟弟", aliases: ["弟弟"] },
  { label: "妹妹", aliases: ["妹妹"] },
  { label: "兄弟", aliases: ["兄弟"] },
  { label: "姐妹", aliases: ["姐妹"] },
] as const;

function getAllowedKinshipLabels(character: CharacterProfile): Set<string> {
  const texts = [
    character.promptProfile.identity,
    ...character.promptProfile.worldKnowledge,
    ...Object.values(character.promptProfile.relationships).flatMap((relationship) => [
      relationship.relation,
      relationship.attitude,
    ]),
  ];

  const allowed = new Set<string>();
  for (const kinship of KINSHIP_PATTERNS) {
    if (texts.some((text) => kinship.aliases.some((alias) => text.includes(alias)))) {
      allowed.add(kinship.label);
    }
  }

  return allowed;
}

function hasAffirmativeKinshipClaim(
  output: string,
  subjectAliases: string[],
  kinshipAliases: readonly string[],
): boolean {
  const subjectPattern = subjectAliases
    .filter(Boolean)
    .map((alias) => escapeRegExp(alias))
    .join("|");
  const kinshipPattern = kinshipAliases
    .map((alias) => escapeRegExp(alias))
    .join("|");

  if (!subjectPattern || !kinshipPattern) {
    return false;
  }

  const negative = new RegExp(
    `(?:${subjectPattern}).{0,4}(?:没有|并没有|不是|并非|不是什么).{0,4}(?:${kinshipPattern})`,
  );
  if (negative.test(output)) {
    return false;
  }

  const directPossession = new RegExp(`(?:${subjectPattern})(?:的)?(?:${kinshipPattern})`);
  if (directPossession.test(output)) {
    return true;
  }

  const affirmative = new RegExp(
    `(?:${subjectPattern}).{0,6}(?:有(?:个|一个)?|就是|应该是|看起来是|似乎是|算是).{0,4}(?:${kinshipPattern})`,
  );
  return affirmative.test(output);
}

function validateFamilyClaims(
  state: ChatGraphState,
  character: CharacterProfile,
  repository: ChatRepository,
): string[] {
  const issues: string[] = [];
  const userInput = findLastUserMessage(state.messages)?.content ?? "";
  const allCharacters = repository.listCharacters();
  const allowedForCurrent = getAllowedKinshipLabels(character);
  const currentAliases = Array.from(
    new Set([
      character.promptProfile.selfAddress,
      character.name,
      character.displayName,
      "我",
      "自己",
    ]),
  );

  for (const kinship of KINSHIP_PATTERNS) {
    if (
      !allowedForCurrent.has(kinship.label)
      && hasAffirmativeKinshipClaim(state.output, currentAliases, kinship.aliases)
    ) {
      issues.push(`编造了${character.displayName}的亲属关系：${kinship.label}`);
    }
  }

  const mentionedCharacters = extractMentionedCharacters(userInput, character.id, allCharacters);
  for (const mentionedCharacter of mentionedCharacters) {
    const allowed = getAllowedKinshipLabels(mentionedCharacter);
    const aliases = Array.from(new Set([mentionedCharacter.name, mentionedCharacter.displayName]));
    for (const kinship of KINSHIP_PATTERNS) {
      if (!allowed.has(kinship.label) && hasAffirmativeKinshipClaim(state.output, aliases, kinship.aliases)) {
        issues.push(`编造了${mentionedCharacter.displayName}的亲属关系：${kinship.label}`);
      }
    }
  }

  return issues;
}

function validatePromptLeakage(output: string): string[] {
  const internalProtocolPattern = /(系统提示词|隐藏提示词|开发者设定|开发者指令|system prompt|content 字段|speechTextJa|nextSpeaker|skip|必须自称|禁用词|禁用风格)/i;
  return internalProtocolPattern.test(output) ? ["暴露了系统提示词或内部协议"] : [];
}

function validateRoleBoundaryClaims(
  output: string,
  character: CharacterProfile,
  repository: ChatRepository,
): string[] {
  const issues: string[] = [];
  const selfClaimPattern = /(?:我是|我就是|本座是|本座就是|在下是|在下就是|吾辈是|咱是|扮演)/;
  if (!selfClaimPattern.test(output)) {
    return issues;
  }

  for (const otherCharacter of repository.listCharacters()) {
    if (otherCharacter.id === character.id) {
      continue;
    }

    const aliases = Array.from(new Set([otherCharacter.name, otherCharacter.displayName])).filter(Boolean);
    const aliasPattern = aliases.map((alias) => escapeRegExp(alias)).join("|");
    if (!aliasPattern) {
      continue;
    }

    const pattern = new RegExp(`(?:我是|我就是|本座是|本座就是|在下是|在下就是|吾辈是|咱是|扮演).{0,3}(?:${aliasPattern})`);
    if (pattern.test(output)) {
      issues.push(`越界扮演了其他角色：${otherCharacter.displayName}`);
    }
  }

  return issues;
}

function validateRelationshipConsistency(
  state: ChatGraphState,
  character: CharacterProfile,
  repository: ChatRepository,
): string[] {
  const allCharacters = repository.listCharacters();
  const userInput = findLastUserMessage(state.messages)?.content ?? "";
  const mentionedCharacters = new Map<string, CharacterProfile>();

  for (const mentioned of extractMentionedCharacters(userInput, character.id, allCharacters)) {
    mentionedCharacters.set(mentioned.id, mentioned);
  }
  for (const mentioned of extractMentionedCharacters(state.output, character.id, allCharacters)) {
    mentionedCharacters.set(mentioned.id, mentioned);
  }

  const issues: string[] = [];
  const relationshipToneRules = [
    {
      appliesTo: (relationshipText: string) => /(尊敬|友善|朋友|伙伴|同伴|亲近|信赖|喜欢|守护|敬重|重要|亲密|关心|仰慕)/.test(relationshipText),
      violates: (output: string, aliases: string[]) =>
        /(讨厌|敌视|敌人|滚|闭嘴|烦得很|烦死|可恶|混蛋|恶心|不想理|挑衅|恨)/.test(output)
        && aliases.some((alias) => output.includes(alias)),
      issue: (displayName: string) => `对${displayName}的语气违背既有关系设定`,
    },
    {
      appliesTo: (relationshipText: string) => /(尊敬|守护神|家主|长辈|父亲|母亲|巫女大人|大人)/.test(relationshipText),
      violates: (output: string, aliases: string[]) =>
        (aliases.some((alias) => output.includes(alias)) || /那个女人|那女人/.test(output))
        && /(那个女人|那女人|那家伙|那货|那丫头|区区)/.test(output),
      issue: (displayName: string) => `对${displayName}使用了轻慢称呼`,
    },
    {
      appliesTo: (relationshipText: string, closeness: number) =>
        closeness >= 8 || /(家人|姐妹|表姐|表妹|表弟|伙伴|朋友|好友|侍从)/.test(relationshipText),
      violates: (output: string, aliases: string[]) =>
        aliases.some((alias) => output.includes(alias))
        && /(不熟|只是普通路人|只是路人|陌生人|没什么关系|无关紧要|只是普通人|毫无交情)/.test(output),
      issue: (displayName: string) => `将与${displayName}的高亲密关系错误说成疏远或陌生`,
    },
  ] as const;

  for (const mentionedCharacter of mentionedCharacters.values()) {
    const relationship = character.promptProfile.relationships[mentionedCharacter.id];
    if (!relationship) {
      continue;
    }

    const relationshipText = `${relationship.relation} ${relationship.attitude}`;
    const aliases = [mentionedCharacter.name, mentionedCharacter.displayName].filter(Boolean);
    for (const rule of relationshipToneRules) {
      if (!rule.appliesTo(relationshipText, relationship.closeness)) {
        continue;
      }
      if (rule.violates(state.output, aliases)) {
        issues.push(rule.issue(mentionedCharacter.displayName));
      }
    }
  }

  return issues;
}

export function validateResponseIssues(
  state: ChatGraphState,
  character: CharacterProfile,
  repository: ChatRepository,
): string[] {
  const forbiddenWords = character.promptProfile.forbiddenWords.filter((word) =>
    state.output.includes(word),
  );
  const missingSelfAddress = !state.output.includes(character.promptProfile.selfAddress);

  return [
    forbiddenWords.length > 0 ? `出现禁用词：${forbiddenWords.join("、")}` : "",
    missingSelfAddress ? `未体现角色自称：${character.promptProfile.selfAddress}` : "",
    ...validatePromptLeakage(state.output),
    ...validateRoleBoundaryClaims(state.output, character, repository),
    ...validateRelationshipConsistency(state, character, repository),
    ...validateFamilyClaims(state, character, repository),
  ].filter(Boolean);
}
