/**
 * 真实 ES 混合检索相似度测试
 * ============================
 * 对多组测试 query 跑 ElasticsearchService.hybridSearch（Dense + BM25 + Tag 三路 RRF 融合 + 语义重排序），
 * 输出 top 结果的 ES 分数与独立计算的 bge-m3 余弦相似度，验证台词库检索的语义相似度效果。
 *
 * 运行: npx tsx scripts/test-retrieval-similarity.ts
 * 依赖: ES 服务 + Ollama bge-m3 已运行，且已执行 npm run index:dialogues
 */
import path from "node:path";
import { createAppConfig } from "../src/backend/config";
import { ElasticsearchService } from "../src/backend/services/es/elasticsearch-service";
import { BgeM3EmbeddingService } from "../src/backend/services/es/bge-m3-embedding-service";
import type { RetrievalFilters } from "../src/common/types";

interface TestCase {
  label: string;
  query: string;
  filters?: RetrievalFilters;
  topK?: number;
}

const TEST_CASES: TestCase[] = [
  { label: "丛雨·神社祈祷", query: "丛雨在神社里虔诚地祈祷", filters: { character: "丛雨" }, topK: 5 },
  { label: "芳乃·厨房做饭", query: "芳乃在厨房里开心地做饭", filters: { character: "芳乃" }, topK: 5 },
  { label: "茉子·安静读书", query: "茉子安静地坐在那里看书", filters: { character: "茉子" }, topK: 5 },
  { label: "蕾娜·发呆", query: "蕾娜又在那里发呆想事情", filters: { character: "蕾娜" }, topK: 5 },
  { label: "情绪·开心笑声", query: "大家开心的笑声", filters: { tags: { emotion: ["开心"] } }, topK: 5 },
  { label: "场景·神社参拜", query: "在神社的鸟居前参拜", filters: { tags: { scene: ["神社"] } }, topK: 5 },
  { label: "纯语义·看星星", query: "今晚的星星好亮，想和你一起看", topK: 5 },
  { label: "纯语义·道别", query: "明天见，路上保重", topK: 5 },
];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function clip(s: string, n: number): string {
  const v = s.replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

async function main(): Promise<void> {
  const cfg = createAppConfig(process.cwd(), path.join(process.cwd(), ".tmp"));
  const es = new ElasticsearchService(cfg);
  const emb = new BgeM3EmbeddingService(cfg);

  if (!es.enabled) {
    console.error("ES 未启用，请检查 ES_ENABLED / ES_PASSWORD 配置。");
    process.exit(1);
  }
  const ok = await es.ping();
  console.log("ES ping:", ok, "| index:", cfg.esDialogueIndex, "| default topK:", cfg.topK, "| dims:", cfg.embeddingDimensions);
  if (!ok) {
    console.error("ES 不可达，请先启动 Elasticsearch。");
    process.exit(1);
  }

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    console.log("\n" + "=".repeat(96));
    console.log(`[${i + 1}/${TEST_CASES.length}] ${tc.label}`);
    console.log(`  query: "${tc.query}"`);
    if (tc.filters) {
      const f: string[] = [];
      if (tc.filters.character) f.push(`character=${tc.filters.character}`);
      if (tc.filters.tags) f.push(`tags=${JSON.stringify(tc.filters.tags)}`);
      console.log(`  filters: ${f.join(", ")}`);
    }
    console.log("-".repeat(96));

    const topK = tc.topK ?? 5;
    const results = await es.hybridSearch(tc.query, { ...tc.filters, topK });
    if (results.length === 0) {
      console.log("  (无结果)");
      continue;
    }

    const qVec = await emb.embed(tc.query);
    const dVecs = await emb.embedMany(results.map((r) => r.text));

    console.log("  rank  esScore   cosine    character   text");
    results.forEach((r, idx) => {
      const cos = cosine(qVec, dVecs[idx]);
      console.log(
        `  ${String(idx + 1).padEnd(5)} ${r.score.toFixed(4).padEnd(9)} ${cos.toFixed(4).padEnd(9)} ${clip(r.character, 11).padEnd(11)} ${clip(r.text, 56)}`,
      );
    });
  }

  console.log("\n" + "=".repeat(96));
  console.log("字段说明:");
  console.log("  esScore = ES hybridSearch 返回分数（触发 rerank 时为余弦相似度，未触发时为 RRF 融合分数）");
  console.log("  cosine  = 独立用 bge-m3 计算 query 与 doc.text 的余弦相似度（-1 ~ 1，越接近 1 语义越相近）");
}

void main().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
