/**
 * Query 改写去角色名 - 效果对比
 * ==============================
 * 验证方案2：检索前剥离 query 中的角色名，避免 embedding 对角色名过度关联。
 * 角色已通过 filter（character=XX）限定，query 里的角色名是冗余信息。
 *
 * original:  原始 query（含角色名）
 * stripped:  去角色名 query（仅保留场景语义），仍带相同 character filter
 *
 * 运行: npx tsx scripts/test-query-rewrite.ts
 */
import path from "node:path";
import { createAppConfig } from "../src/backend/config";
import { ElasticsearchService } from "../src/backend/services/es/elasticsearch-service";
import type { RetrievalFilters } from "../src/common/types";

interface TestCase {
  label: string;
  query: string;
  filters?: RetrievalFilters;
  expectScene: string;
}

const TEST_CASES: TestCase[] = [
  { label: "丛雨·神社祈祷", query: "丛雨在神社里虔诚地祈祷", filters: { character: "丛雨" }, expectScene: "祈祷/神社/丛雨丸" },
  { label: "芳乃·厨房做饭", query: "芳乃在厨房里开心地做饭", filters: { character: "芳乃" }, expectScene: "做饭/便当/厨房" },
  { label: "茉子·安静读书", query: "茉子安静地坐在那里看书", filters: { character: "茉子" }, expectScene: "读书/看书/安静" },
  { label: "蕾娜·发呆", query: "蕾娜又在那里发呆想事情", filters: { character: "蕾娜" }, expectScene: "发呆/想事情/出神" },
  { label: "纯语义·看星星", query: "今晚的星星好亮，想和你一起看", expectScene: "星星/夜空" },
  { label: "纯语义·道别", query: "明天见，路上保重", expectScene: "明天见/道别/保重" },
];

// 角色名集合（长名优先，避免短名先替换破坏长名）
const CHARACTER_NAMES = [
  "蕾娜·列支敦瑙尔",
  "常陆茉子",
  "朝武芳乃",
  "丛雨丸",
  "丛雨",
  "芳乃",
  "茉子",
  "蕾娜",
  "将臣",
];

function stripCharacterName(query: string): string {
  let result = query;
  for (const name of CHARACTER_NAMES) {
    result = result.split(name).join("");
  }
  // 清理首尾空格和多余空格
  return result.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  const v = s.replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

function isRelevant(text: string, expectScene: string): boolean {
  const keywords = expectScene.split("/").map((k) => k.trim());
  return keywords.some((k) => k.length > 0 && text.includes(k));
}

async function main(): Promise<void> {
  const cfg = createAppConfig(process.cwd(), path.join(process.cwd(), ".tmp"));
  const es = new ElasticsearchService(cfg);
  if (!es.enabled) {
    console.error("ES 未启用");
    process.exit(1);
  }
  const ok = await es.ping();
  console.log("ES ping:", ok, "| index:", cfg.esDialogueIndex);
  if (!ok) process.exit(1);

  const topK = 5;
  let origRelevant = 0;
  let stripRelevant = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    const strippedQuery = stripCharacterName(tc.query);

    console.log("\n" + "=".repeat(104));
    console.log(`[${i + 1}/${TEST_CASES.length}] ${tc.label}`);
    console.log(`  original:  "${tc.query}"`);
    console.log(`  stripped:  "${strippedQuery}"${tc.query === strippedQuery ? "  (无变化)" : ""}`);
    console.log(`  期望场景: ${tc.expectScene}`);
    if (tc.filters?.character) console.log(`  filters: character=${tc.filters.character}（两路均保留）`);
    console.log("-".repeat(104));

    const [origRes, stripRes] = await Promise.all([
      es.hybridSearch(tc.query, { ...tc.filters, topK }),
      es.hybridSearch(strippedQuery, { ...tc.filters, topK }),
    ]);

    const oRel = origRes.length > 0 && isRelevant(origRes[0].text, tc.expectScene);
    const sRel = stripRes.length > 0 && isRelevant(stripRes[0].text, tc.expectScene);
    if (oRel) origRelevant++;
    if (sRel) stripRelevant++;

    console.log(`  【original】 top1相关: ${oRel ? "是" : "否"}`);
    console.log("  rank  score     character   text");
    origRes.slice(0, 3).forEach((r, idx) => {
      console.log(`  ${String(idx + 1).padEnd(5)} ${r.score.toFixed(4).padEnd(9)} ${clip(r.character, 11).padEnd(11)} ${clip(r.text, 56)}`);
    });

    console.log(`\n  【stripped】 top1相关: ${sRel ? "是" : "否"}`);
    console.log("  rank  score     character   text");
    stripRes.slice(0, 3).forEach((r, idx) => {
      console.log(`  ${String(idx + 1).padEnd(5)} ${r.score.toFixed(4).padEnd(9)} ${clip(r.character, 11).padEnd(11)} ${clip(r.text, 56)}`);
    });

    const oTop = origRes[0]?.sourceId;
    const sTop = stripRes[0]?.sourceId;
    if (oTop && sTop) {
      const changed = oTop !== sTop;
      const improved = !oRel && sRel;
      const tag = improved ? " ⬆ 改善" : (oRel && !sRel ? " ⬇ 退化" : (changed ? " ⚡ 变化" : ""));
      console.log(`\n  top1 变化: ${changed ? "是" : "否"}${tag}`);
    }
  }

  console.log("\n" + "=".repeat(104));
  console.log("  汇总：top1 场景相关数");
  console.log(`  original (含角色名):  ${origRelevant}/${TEST_CASES.length}`);
  console.log(`  stripped (去角色名):  ${stripRelevant}/${TEST_CASES.length}`);
  console.log("-".repeat(104));
  console.log("  关注：case 2/3/4 的 top1 是否从「自我介绍」变为「场景台词」，且 score 是否提升。");
}

void main().catch((e) => {
  console.error("对比失败:", e);
  process.exit(1);
});
