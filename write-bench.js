const fs = require("fs");

const content = `/**
 * LangSmith Agent Benchmark (v2)
 * ================================
 * 测试 agent 每个 graph 节点的耗时。
 * 上传 trace 到 LangSmith 并打印本地耗时排名。
 *
 * 运行: npm run benchmark
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { createAppConfig } from "../src/backend/config";
import { ChatRepository } from "../src/backend/db/database";
import { createSingleChatGraph, type GraphDependencies } from "../src/backend/graph/chat-graphs";
import { CharacterService } from "../src/backend/services/characters/character-service";
import { DeepSeekService } from "../src/backend/services/llm/deepseek-service";
import { MemoryService } from "../src/backend/services/memory/memory-service";
import { SseService } from "../src/backend/services/stream/sse-service";
import { TtsService } from "../src/backend/services/tts/tts-service";

// ── LangGraph node-level timing callback ──
class NodeTiming extends BaseCallbackHandler {
  name = "NodeTiming";
  private readonly stack = new Map<string, { node: string; start: number }[]>();
  private readonly _results: Array<{ node: string; ms: number }> = [];

  handleChainStart(run: { id: string; name: string }): void {
    if (!this.stack.has(run.id)) this.stack.set(run.id, []);
    this.stack.get(run.id)!.push({ node: run.name, start: performance.now() });
  }

  handleChainEnd(run: { id: string; name: string }): void {
    const s = this.stack.get(run.id);
    if (s && s.length) {
      const entry = s.pop()!;
      this._results.push({ node: entry.node, ms: Math.round(performance.now() - entry.start) });
    }
  }

  handleChainError(run: { id: string; name: string }): void {
    const s = this.stack.get(run.id);
    if (s && s.length) s.pop();
  }

  get results(): ReadonlyArray<{ node: string; ms: number }> {
    return this._results;
  }

  printSummary(): void {
    const by = new Map<string, number[]>();
    for (const r of this._results) {
      const a = by.get(r.node) ?? [];
      a.push(r.ms);
      by.set(r.node, a);
    }
    const sorted = [...by].map(([node, ms]) => {
      const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
      return { node, avg, max: Math.max(...ms), min: Math.min(...ms), n: ms.length };
    }).sort((a, b) => b.avg - a.avg);

    console.log("\\n" + "=".repeat(80));
    console.log("  Agent Pipeline - \u73AF\u8282\u8017\u65F6\u6392\u540D");
    console.log("=".repeat(80));
    console.log("  " + "\u8282\u70B9\u540D\u79F0".padEnd(22) + "\u5E73\u5747(ms)".padEnd(10) + "\u6700\u5927(ms)".padEnd(10) + "\u6700\u5C0F(ms)".padEnd(10) + "\u8C03\u7528\u6B21\u6570");
    console.log("  " + "-".repeat(68));
    for (const s of sorted) {
      const bar = s.avg > 0 ? "\u2588".repeat(Math.max(1, Math.floor(s.avg / 100))) : "";
      console.log("  " + s.node.padEnd(22) + String(s.avg).padEnd(10) + String(s.max).padEnd(10) + String(s.min).padEnd(10) + String(s.n) + "  " + bar);
    }
    console.log("=".repeat(80));
    const totals = this._results.map(r => r.ms);
    const totalAvg = Math.round(totals.reduce((a, b) => a + b, 0) / Math.max(1, this._results.length));
    console.log("  \u5E73\u5747\u6BCF\u8282\u70B9\u8017\u65F6: " + totalAvg + " ms");
    console.log("=".repeat(80));
  }
}

// ── Config ──
const DISTINCT_CHARACTERS = [
  { id: "\u82B3\u4E43", msg: "\u82B3\u4E43\uFF0C\u4ECA\u5929\u5929\u6C14\u771F\u597D\uFF0C\u6211\u4EEC\u4E00\u8D77\u51FA\u53BB\u8D70\u8D70\u5427\u3002" },
  { id: "\u8309\u5B50", msg: "\u8309\u5B50\uFF0C\u6700\u8FD1\u5728\u5FD9\u4EC0\u4E48\uFF1F\u603B\u89C9\u5F97\u4F60\u597D\u51E0\u5929\u6CA1\u597D\u597D\u4F11\u606F\u4E86\u3002" },
  { id: "\u857E\u5A1C", msg: "\u857E\u5A1C\uFF0C\u4F60\u53C8\u5728\u53D1\u5446\uFF0C\u5728\u60F3\u4EC0\u4E48\u5462\uFF1F" },
  { id: "\u4E1B\u96E8", msg: "\u4E1B\u96E8\uFF0C\u4ECA\u665A\u7684\u661F\u661F\u5F88\u4EAE\u5462\uFF0C\u4F60\u770B\u5230\u4E86\u5417\uFF1F" },
];

// ── Main ──
async function main(): Promise<void> {
  dotenv.config();
  const appRoot = process.cwd();
  const userDataPath = path.join(appRoot, ".web-data");
  const config = createAppConfig(appRoot, userDataPath);

  if (!config.deepseekApiKey) { console.error("\\u7F3A DEEPSEEK_API_KEY"); process.exit(1); }
  if (!config.esPassword) console.warn("ES \u65E0\u5BC6\u7801\uFF0C\u5C06\u8DF3\u8FC7\u68C0\u7D22");

  const tracing = process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY;
  console.log("LangSmith Tracing: " + tracing + "  project=" + config.langsmithProject);

  const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), "senren-bench-"));
  const bc = { ...config, sqlitePath: path.join(tmpDb, "bench.sqlite") };
  const repo = new ChatRepository(bc.sqlitePath);
  repo.init();
  const sse = new SseService();
  const chars = new CharacterService(bc);
  const es = new (require("../src/backend/services/es/elasticsearch-service").ElasticsearchService)(bc);
  const llm = new DeepSeekService(bc);
  const mem = new MemoryService(repo, es, llm);
  const tts = new TtsService(bc);

  const characters = await chars.loadCharacters();
  repo.upsertCharacters(characters);
  const charMap = new Map(characters.map(c => [c.id, c]));

  let esOk = false;
  if (es.enabled) { esOk = await es.ping(); if (!esOk) console.warn("ES\u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u68C0\u7D22"); }
  console.log("\\u89D2\u8272: " + characters.length + "  ES: " + esOk + "  LLM: " + bc.deepseekModel + "  \\u4E34\u65F6DB: " + tmpDb + "\\n");

  const tracer = tracing ? new LangChainTracer({ projectName: bc.langsmithProject }) : undefined;
  const timing = new NodeTiming();

  for (let i = 0; i < DISTINCT_CHARACTERS.length; i++) {
    const { id, msg } = DISTINCT_CHARACTERS[i];
    const ch = charMap.get(id);
    if (!ch) { console.warn("\\u8DF3\u8FC7: " + id); continue; }

    const chat = repo.createChat("single", [id], "bench-" + i);
    repo.appendMessage({ id: "bench-u-" + i, chatId: chat.id, role: "user", content: msg });

    const deps: GraphDependencies = {
      repository: repo, characterService: chars,
      elasticsearchService: es as never,
      deepSeekService: llm as never,
      memoryService: mem as never,
      sseService: sse as never, ttsService: tts as never,
    };
    const graph = createSingleChatGraph(deps);
    const cbs: unknown[] = [];
    if (tracer) cbs.push(tracer);
    cbs.push(timing);

    console.log("[" + (i + 1) + "/" + DISTINCT_CHARACTERS.length + "] " + ch.displayName + "...");

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout 120s")), 120_000));
    try {
      await Promise.race([
        graph.invoke({
          chatId: chat.id, streamId: "bench-" + i + "-" + Date.now(),
          mode: "single", participants: [id], mentionTarget: null,
          activeRoleIndex: 0, currentRoleId: undefined,
          messages: repo.listMessages(chat.id),
          retrievedDocs: [], memories: [], summary: undefined,
          prompt: "", output: "", speechTextJa: "", retryCount: 0,
          validationIssue: undefined, character: undefined,
        }, { recursionLimit: 100, callbacks: cbs }),
        timeout,
      ]);
      console.log("  \\u2705 \\u5B8C\u6210");
    } catch (err) {
      console.error("  \\u274c " + (err instanceof Error ? err.message : err));
    }
  }

  timing.printSummary();
  if (tracer) console.log("\\nTrace \u5DF2\u4E0A\u4F20\u5230 LangSmith: " + bc.langsmithProject + "\\n\\u6BCF\u4E2A trace \u5305\u542B\u6BCF\u4E2A graph \u8282\u70B9\u7684\u65F6\u957F");

  repo.close();
  fs.rmSync(tmpDb, { recursive: true, force: true });
  console.log("\\u6E05\u7406\u5B8C\u6210\\n");
}

void main().catch(e => { console.error("Benchmark \u5931\u8D25:", e); process.exit(1); });
`;

fs.writeFileSync("F:/yoshino/my-rp-chat-app/benchmark/agent-benchmark.ts", content, "utf8");
console.log("Written OK, " + content.length + " bytes");
