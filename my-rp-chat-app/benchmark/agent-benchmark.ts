/**
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
import { ElasticsearchService } from "../src/backend/services/es/elasticsearch-service";
import { LlmService } from "../src/backend/services/llm/llm-service";
import { MemoryService } from "../src/backend/services/memory/memory-service";
import { SseService } from "../src/backend/services/stream/sse-service";
import { TtsService } from "../src/backend/services/tts/tts-service";

// ── LangGraph node-level timing callback ──
class NodeTiming extends BaseCallbackHandler {
  name = "NodeTiming";
  private readonly stack = new Map<string, { node: string; start: number }[]>();
  private readonly _results: Array<{ node: string; ms: number }> = [];

  handleChainStart(_chain: any, _inputs: any, runId: string, _runType: any = undefined, _tags: any = undefined, _metadata: any = undefined, runName: any = undefined, *_extra: any[]): void {
    if (!this.stack.has(runId)) this.stack.set(runId, []);
    this.stack.get(runId)!.push({ node: runName ?? _chain?.name ?? "", start: performance.now() });
  }

  handleChainEnd(_outputs: any, runId: string, *_extra: any[]): void {
    const s = this.stack.get(runId);
    if (s && s.length) {
      const entry = s.pop()!;
      this._results.push({ node: entry.node, ms: Math.round(performance.now() - entry.start) });
    }
  }

  handleChainError(_err: any, runId: string, *_extra: any[]): void {
    const s = this.stack.get(runId);
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

    console.log("\n" + "=".repeat(80));
    console.log("  Agent Pipeline - 环节耗时排名");
    console.log("=".repeat(80));
    console.log("  " + "节点名称".padEnd(22) + "平均(ms)".padEnd(10) + "最大(ms)".padEnd(10) + "最小(ms)".padEnd(10) + "调用次数");
    console.log("  " + "-".repeat(68));
    for (const s of sorted) {
      const bar = s.avg > 0 ? "█".repeat(Math.max(1, Math.floor(s.avg / 100))) : "";
      console.log("  " + s.node.padEnd(22) + String(s.avg).padEnd(10) + String(s.max).padEnd(10) + String(s.min).padEnd(10) + String(s.n) + "  " + bar);
    }
    console.log("=".repeat(80));
    const totals = this._results.map(r => r.ms);
    const totalAvg = Math.round(totals.reduce((a, b) => a + b, 0) / Math.max(1, this._results.length));
    console.log("  平均每节点耗时: " + totalAvg + " ms");
    console.log("=".repeat(80));
  }
}

// ── Config ──
const DISTINCT_CHARACTERS = [
  { id: "芳乃", msg: "芳乃，今天天气真好，我们一起出去走走吧。" },
  { id: "茉子", msg: "茉子，最近在忙什么？总觉得你好几天没好好休息了。" },
  { id: "蕾娜", msg: "蕾娜，你又在发呆，在想什么呢？" },
  { id: "丛雨", msg: "丛雨，今晚的星星很亮呢，你看到了吗？" },
];

// ── Main ──
async function main(): Promise<void> {
  dotenv.config();
  const appRoot = process.cwd();
  const userDataPath = path.join(appRoot, ".web-data");
  const config = createAppConfig(appRoot, userDataPath);

  if (!config.llmApiKey) { console.error("缺 LLM_API_KEY"); process.exit(1); }
  if (!config.esPassword) console.warn("ES 无密码，将跳过检索");

  const tracing = process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY;
  console.log("LangSmith Tracing: " + tracing + "  project=" + config.langsmithProject);

  const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), "senren-bench-"));
  const bc = { ...config, sqlitePath: path.join(tmpDb, "bench.sqlite") };
  const repo = new ChatRepository(bc.sqlitePath);
  repo.init();
  const sse = new SseService();
  const chars = new CharacterService(bc);
  const es = new ElasticsearchService(bc);
  const llm = new LlmService(bc);
  const mem = new MemoryService(repo, es, llm);
  const tts = new TtsService(bc);

  const characters = await chars.loadCharacters();
  repo.upsertCharacters(characters);
  const charMap = new Map(characters.map(c => [c.id, c]));

  let esOk = false;
  if (es.enabled) { esOk = await es.ping(); if (!esOk) console.warn("ES不可用，跳过检索"); }
  console.log("\u89D2色: " + characters.length + "  ES: " + esOk + "  LLM: " + bc.llmModel + "  \u4E34时DB: " + tmpDb + "\n");

  const tracer = tracing ? new LangChainTracer({ projectName: bc.langsmithProject }) : undefined;
  const timing = new NodeTiming();

  for (let i = 0; i < DISTINCT_CHARACTERS.length; i++) {
    const { id, msg } = DISTINCT_CHARACTERS[i];
    const ch = charMap.get(id);
    if (!ch) { console.warn("\u8DF3过: " + id); continue; }

    const chat = repo.createChat("single", [id], "bench-" + i);
    repo.appendMessage({ id: "bench-u-" + i, chatId: chat.id, role: "user", content: msg });

    const deps: GraphDependencies = {
      repository: repo, characterService: chars,
      elasticsearchService: es as never,
      llmService: llm as never,
      memoryService: mem as never,
      sseService: sse as never, ttsService: tts as never,
    };
    const graph = createSingleChatGraph(deps);
    const cbs: BaseCallbackHandler[] = [];
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
      console.log("  \u2705 \u5B8C成");
    } catch (err) {
      console.error("  \u274c " + (err instanceof Error ? err.message : err));
    }
  }

  timing.printSummary();
  if (tracer) console.log("\nTrace 已上传到 LangSmith: " + bc.langsmithProject + "\n\u6BCF个 trace 包含每个 graph 节点的时长");

  repo.close();
  fs.rmSync(tmpDb, { recursive: true, force: true });
  console.log("\u6E05理完成\n");
}

void main().catch(e => { console.error("Benchmark 失败:", e); process.exit(1); });
