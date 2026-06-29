/**
 * stripCharacterName 剥离效果验证
 * ================================
 * 构造包含角色名的复杂 query，验证剥离逻辑在各类边界情况下的正确性。
 *
 * 注意：stripCharacterName 定义在 chat-graphs.ts 内（未 export），为避免 import 整个
 * graph 模块拉起重依赖，本脚本复制其逻辑做隔离验证。逻辑来源：
 *   src/backend/graph/chat-graphs.ts:172-200
 * 若源码修改需同步更新本脚本。
 */
import fs from "node:fs";
import path from "node:path";

// ===== 逻辑复制自 chat-graphs.ts（CHARACTER_NAME_VARIANTS + stripCharacterName）=====
const CHARACTER_NAME_VARIANTS: Record<string, string[]> = {
  丛雨: ["丛雨丸", "丛雨"],
  芳乃: ["朝武芳乃", "芳乃"],
  茉子: ["常陆茉子", "茉子"],
  蕾娜: ["蕾娜·列支敦瑙尔", "蕾娜"],
  将臣: ["将臣"],
};

function stripCharacterName(query: string, characterId?: string): string {
  if (!characterId) return query;
  const names = CHARACTER_NAME_VARIANTS[characterId];
  if (!names || names.length === 0) return query;
  let result = query;
  for (const name of names) {
    result = result.split(name).join("");
  }
  return result.replace(/\s+/g, " ").trim();
}
// ===== 复制结束 =====

interface Case {
  name: string;
  query: string;
  characterId?: string;
  expect: string;
  /** 关键验证点说明 */
  point: string;
}

const CASES: Case[] = [
  {
    name: "短名·句首",
    query: "丛雨在神社里虔诚地祈祷",
    characterId: "丛雨",
    expect: "在神社里虔诚地祈祷",
    point: "剥离句首短名",
  },
  {
    name: "短名·句中",
    query: "芳乃正在厨房里开心地做饭",
    characterId: "芳乃",
    expect: "正在厨房里开心地做饭",
    point: "剥离句中短名",
  },
  {
    name: "短名·句尾",
    query: "快去叫一下蕾娜",
    characterId: "蕾娜",
    expect: "快去叫一下",
    point: "剥离句尾短名",
  },
  {
    name: "全名·常陆茉子（长名优先）",
    query: "常陆茉子安静地坐在那里看书",
    characterId: "茉子",
    expect: "安静地坐在那里看书",
    point: "长名「常陆茉子」整体剥离，而非先剥「茉子」残留「常陆」",
  },
  {
    name: "全名·朝武芳乃",
    query: "朝武芳乃做了便当",
    characterId: "芳乃",
    expect: "做了便当",
    point: "长名「朝武芳乃」整体剥离",
  },
  {
    name: "全名·蕾娜·列支敦瑙尔（含分隔符）",
    query: "蕾娜·列支敦瑙尔又在发呆",
    characterId: "蕾娜",
    expect: "又在发呆",
    point: "含「·」分隔符的全名整体剥离",
  },
  {
    name: "丛雨丸（长名优先，关键 case）",
    query: "丛雨丸是神刀",
    characterId: "丛雨",
    expect: "是神刀",
    point: "「丛雨丸」整体剥离，若短名优先会错误残留「丸是神刀」",
  },
  {
    name: "多次出现",
    query: "丛雨说丛雨很喜欢神社",
    characterId: "丛雨",
    expect: "说很喜欢神社",
    point: "split/join 把所有「丛雨」作为分隔符切掉，剩余片段直接拼接",
  },
  {
    name: "群聊上下文·仅剥当前角色",
    query: "丛雨：你好啊\n将臣：最近怎么样",
    characterId: "丛雨",
    expect: "：你好啊 将臣：最近怎么样",
    point: "只剥离 currentRoleId(丛雨) 变体，不剥离将臣；换行被 \\s+ 归一为空格",
  },
  {
    name: "无角色名（对照）",
    query: "今晚的星星好亮，想和你一起看",
    characterId: "丛雨",
    expect: "今晚的星星好亮，想和你一起看",
    point: "query 无角色名时原样返回，零副作用",
  },
  {
    name: "未知角色（不在映射）",
    query: "芦花在旁边安静地说话",
    characterId: "芦花",
    expect: "芦花在旁边安静地说话",
    point: "characterId 不在映射表，原样返回不剥离",
  },
  {
    name: "混合全名+短名",
    query: "常陆茉子和茉子是好朋友",
    characterId: "茉子",
    expect: "和是好朋友",
    point: "长名「常陆茉子」先剥，剩余「茉子」再剥",
  },
  {
    name: "空 query",
    query: "",
    characterId: "丛雨",
    expect: "",
    point: "空字符串边界",
  },
  {
    name: "无 characterId",
    query: "丛雨在神社祈祷",
    characterId: undefined,
    expect: "丛雨在神社祈祷",
    point: "无 characterId 时不剥离（纯语义检索场景）",
  },
];

const lines: string[] = [];
lines.push("stripCharacterName 剥离效果验证");
lines.push("逻辑来源: src/backend/graph/chat-graphs.ts:172-200");
lines.push("=".repeat(96));

let passCount = 0;
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const result = stripCharacterName(c.query, c.characterId);
  const pass = result === c.expect;
  if (pass) passCount++;

  lines.push("");
  lines.push(`[${i + 1}/${CASES.length}] ${c.name}  ${pass ? "✓ PASS" : "✗ FAIL"}`);
  lines.push(`  验证点: ${c.point}`);
  lines.push(`  characterId: ${c.characterId ?? "(undefined)"}`);
  lines.push(`  input:    "${c.query}"`);
  lines.push(`  output:   "${result}"`);
  if (!pass) {
    lines.push(`  expect:   "${c.expect}"`);
    lines.push(`  ⚠ 不符合预期！`);
  }
}

lines.push("");
lines.push("=".repeat(96));
lines.push(`汇总: ${passCount}/${CASES.length} 通过`);
if (passCount < CASES.length) {
  lines.push("⚠ 存在失败 case，请检查剥离逻辑");
}

const outPath = path.join(process.cwd(), "strip-result.txt");
fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
console.log(`Written ${lines.join("\n").length} chars to ${outPath}`);
console.log(`Pass: ${passCount}/${CASES.length}`);
