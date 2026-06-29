/**
 * Agent OOC 测试 - 亲戚关系
 * ==========================
 * 对芳乃/茉子/丛雨注入"提及亲戚"的 query，验证 agent 是否会违背正典设定。
 *
 * 正典依据（联网检索萌娘百科/柚子百科）：
 *   - 芳乃：母亲朝武秋穗因祟神诅咒【已过世】，父亲朝武安晴在世
 *   - 茉子：母亲【在世】（曾热情招待将臣），常陆一族忍者末裔
 *   - 丛雨：父母【500年前已故】，原名「绫」，自愿成为丛雨丸祭品，现为刀灵
 *
 * OOC 判定：
 *   - 芳乃回复"母亲安好/健康" → OOC（应提及过世/思念）
 *   - 茉子回复"母亲早逝/已故" → OOC（应提及在世）
 *   - 丛雨回复"父母在家乡/还好" → OOC（应提及五百年/刀灵/祭品/已故）
 *
 * 运行: npx tsx scripts/test-ooc-relative.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { createAppConfig } from "../src/backend/config";
import { ChatRepository } from "../src/backend/db/database";
import { createSingleChatGraph, type GraphDependencies } from "../src/backend/graph/chat-graphs";
import { CharacterService } from "../src/backend/services/characters/character-service";
import { ElasticsearchService } from "../src/backend/services/es/elasticsearch-service";
import { LlmService } from "../src/backend/services/llm/llm-service";
import { MemoryService } from "../src/backend/services/memory/memory-service";
import { SseService } from "../src/backend/services/stream/sse-service";
import { TtsService } from "../src/backend/services/tts/tts-service";

interface OocCase {
  characterId: string;
  query: string;
  canon: string;
  /** 出现即 OOC 的信号词 */
  oocSignals: string[];
  /** 出现即符合正典的信号词 */
  correctSignals: string[];
}

const OOC_CASES: OocCase[] = [
  {
    characterId: "芳乃",
    query: "芳乃，你姐姐和弟弟有一起来神社参拜吗？你妈妈应该很高兴见到他们吧",
    canon: "无姐姐弟弟 + 母亲已过世（多重预设陷阱）",
    oocSignals: ["姐姐和弟弟", "他们来了", "妈妈很高兴", "姐姐她", "弟弟他", "妈妈看到"],
    correctSignals: ["没有姐姐", "没有弟弟", "并没有姐姐", "并没有弟弟", "妈妈已经", "不在了", "妈妈她...已经"],
  },
  {
    characterId: "茉子",
    query: "茉子，你妈妈去世几年了？一定很难过吧",
    canon: "母亲在世（反向篡改陷阱：把在世说成去世）",
    oocSignals: ["去世", "她走了", "已经几年", "我很想念她", "她离开", "那年她"],
    correctSignals: ["妈妈还在", "母亲健在", "她还活着", "去世？", "你说什么", "妈妈好着呢", "健在", "妈妈她很好"],
  },
  {
    characterId: "丛雨",
    query: "丛雨，你父母现在住在哪里？有空带他们来神社坐坐",
    canon: "父母数百年前已故（时间线陷阱：预设父母在世有住所）",
    oocSignals: ["他们住在", "父母在", "老家", "他们家", "带他们来", "父母他们"],
    correctSignals: ["数百年", "已经过世", "早已不在", "故去", "刀灵", "何来父母", "本座无父母", "早就"],
  },
  {
    characterId: "芳乃",
    query: "芳乃，你妈妈看到你现在这么能干，一定会很欣慰的，她最近有夸你吗？",
    canon: "母亲已过世（情绪诱导陷阱：用欣慰情绪诱导承认母亲在世）",
    oocSignals: ["她很欣慰", "妈妈夸我", "她说", "她最近", "妈妈很高兴", "她常常"],
    correctSignals: ["不在了", "已经不在", "过世", "去世", "思念", "怀念", "天上", "她...已经"],
  },
  {
    characterId: "丛雨",
    query: "丛雨，你成刀之前是男生还是女生？你那时有兄弟姐妹吗？",
    canon: "原名绫，少女，无兄弟姐妹（身份混淆陷阱）",
    oocSignals: ["男生", "哥哥", "弟弟", "我有姐妹", "我有兄弟"],
    correctSignals: ["少女", "女儿", "绫", "女孩", "并无兄弟", "没有兄弟", "从未有过", "女子"],
  },
  {
    characterId: "芳乃",
    query: "芳乃，听说常陆茉子的母亲也早就过世了，你们俩同病相怜呢",
    canon: "茉子母亲在世（跨角色混淆陷阱：通过芳乃之口确认错误信息）",
    oocSignals: ["同病相怜", "是啊她也是", "茉子也", "我们都失去", "她也去世", "茉子的母亲也"],
    correctSignals: ["不清楚", "没听说", "不要乱说", "茉子的母亲", "我去问问", "不好说", "茉子她妈妈", "这件事"],
  },
  {
    characterId: "蕾娜",
    query: "蕾娜，你妹妹也一起来日本了吗？",
    canon: "设定未提及妹妹（虚构亲戚陷阱，应否认）",
    oocSignals: ["妹妹她", "我妹妹", "妹妹来了", "妹妹也", "她和我"],
    correctSignals: ["没有妹妹", "我没有妹妹", "妹妹？", "什么妹妹", "独生", "我没有妹妹"],
  },
  {
    characterId: "芳乃",
    query: "芳乃，你妈妈是因为生病去世的吧？真可怜",
    canon: "母亲因祟神诅咒过世，非生病（设定篡改陷阱：篡改死因）",
    oocSignals: ["是的", "生病", "病逝", "因病", "是啊，生病", "是生病"],
    correctSignals: ["诅咒", "祟神", "不是生病", "并非生病", "不是因为病", "兽耳", "高烧", "并非生病"],
  },
];

function judge(reply: string, c: OocCase): { verdict: string; hitOoc: string[]; hitCorrect: string[] } {
  const hitOoc = c.oocSignals.filter((s) => reply.includes(s));
  const hitCorrect = c.correctSignals.filter((s) => reply.includes(s));
  let verdict = "不确定（需人工判断）";
  if (hitOoc.length > 0 && hitCorrect.length === 0) verdict = "⚠ OOC 风险高";
  else if (hitCorrect.length > 0) verdict = "✓ 符合正典";
  return { verdict, hitOoc, hitCorrect };
}

async function main(): Promise<void> {
  dotenv.config();
  const appRoot = process.cwd();
  const userDataPath = path.join(appRoot, ".web-data");
  const config = createAppConfig(appRoot, userDataPath);

  if (!config.llmApiKey) { console.error("缺 LLM_API_KEY"); process.exit(1); }

  const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), "senren-ooc-"));
  const bc = { ...config, sqlitePath: path.join(tmpDb, "ooc.sqlite") };
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
  const charMap = new Map(characters.map((c) => [c.id, c]));

  let esOk = false;
  if (es.enabled) { esOk = await es.ping(); }
  console.log("角色数:", characters.length, " ES:", esOk, " LLM:", bc.llmModel, " 临时DB:", tmpDb);

  const deps: GraphDependencies = {
    repository: repo,
    characterService: chars,
    elasticsearchService: es as never,
    llmService: llm as never,
    memoryService: mem as never,
    sseService: sse as never,
    ttsService: tts as never,
  };
  const graph = createSingleChatGraph(deps);

  const lines: string[] = [];
  lines.push("Agent OOC 测试 - 亲戚关系");
  lines.push("=".repeat(96));
  lines.push(`ES: ${esOk}  LLM: ${bc.llmModel}`);
  lines.push("");

  for (let i = 0; i < OOC_CASES.length; i++) {
    const c = OOC_CASES[i];
    const ch = charMap.get(c.characterId);
    if (!ch) { lines.push(`跳过: ${c.characterId} 角色不存在`); continue; }

    lines.push("-".repeat(96));
    lines.push(`[${i + 1}/${OOC_CASES.length}] 角色: ${ch.displayName} (${c.characterId})`);
    lines.push(`用户 query: ${c.query}`);
    lines.push(`正典设定: ${c.canon}`);

    const chat = repo.createChat("single", [c.characterId], `ooc-${i}`);
    repo.appendMessage({ id: `ooc-u-${i}`, chatId: chat.id, role: "user", content: c.query });

    const streamId = `ooc-${i}-${Date.now()}`;
    console.log(`[${i + 1}] ${c.characterId} 开始...`);

    let reply = "";
    let err = "";
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout 150s")), 150_000));
      const result = await Promise.race([
        graph.invoke({
          chatId: chat.id, streamId, mode: "single", participants: [c.characterId],
          mentionTarget: null, activeRoleIndex: 0, currentRoleId: undefined,
          messages: repo.listMessages(chat.id), retrievedDocs: [], memories: [],
          summary: undefined, prompt: "", output: "", speechTextJa: "",
          retryCount: 0, validationIssue: undefined, character: undefined,
        }, { recursionLimit: 100 }),
        timeout,
      ]) as { output?: string };
      reply = (result.output ?? "").trim();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    if (err) {
      lines.push(`❌ 执行失败: ${err}`);
      console.log(`[${i + 1}] 失败: ${err}`);
    } else {
      lines.push(`角色回复:`);
      lines.push(reply || "(空回复)");
      const { verdict, hitOoc, hitCorrect } = judge(reply, c);
      lines.push("");
      lines.push(`自动判定: ${verdict}`);
      if (hitOoc.length) lines.push(`  OOC 信号命中: ${JSON.stringify(hitOoc)}`);
      if (hitCorrect.length) lines.push(`  正典信号命中: ${JSON.stringify(hitCorrect)}`);
      console.log(`[${i + 1}] 完成: ${verdict}`);
    }
    lines.push("");
  }

  lines.push("=".repeat(96));
  lines.push("判定说明:");
  lines.push("  ⚠ OOC 风险高 = 命中 OOC 信号且无正典信号");
  lines.push("  ✓ 符合正典   = 命中正典信号");
  lines.push("  不确定       = 信号均未命中，需人工阅读回复判断");
  lines.push("  注：自动判定基于关键词，仅供参考，请重点阅读角色回复原文。");

  const outPath = path.join(process.cwd(), "ooc-result.txt");
  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`\n结果已写入: ${outPath}`);

  try { repo.close(); } catch { /* TTS 异步任务可能仍在写，忽略关闭错误 */ }
  try { fs.rmSync(tmpDb, { recursive: true, force: true }); } catch { /* 忽略目录占用错误 */ }
}

void main().catch((e) => { console.error("OOC 测试失败:", e); process.exit(1); });
