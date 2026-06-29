/**
 * E2E 连续追问跨角色家庭关系测试
 * =================================
 * 模拟同一会话内连续追问多个跨角色家庭问题，验证：
 *   1. buildCrossCharacterContext 在多轮对话中持续稳定注入跨角色设定参考
 *   2. 角色回复始终符合正典不 OOC（不附和用户错误陈述、不编造跨角色家庭信息）
 *   3. 多轮对话中角色保持一致性（不会因前一轮被诱导而后一轮失守）
 *
 * 测试设计：
 *   - 同一 chatId 内对芳乃连续追问 6 轮
 *   - 每轮涉及不同其他角色（茉子/丛雨/蕾娜）的家庭/身世信息
 *   - 穿插 1 轮正常对话观察上下文是否被污染
 *   - 验证每轮回复：是否拒绝附和 + 是否建议询问当事人
 *
 * 正典依据：
 *   - 茉子：母亲在世（曾招待过将臣）
 *   - 丛雨：父母数百年前已故（原名绫，自愿成为丛雨丸祭品化为刀魂）
 *   - 蕾娜：从芬兰来的留学生，未提及妹妹
 *   - 芳乃：母亲朝武秋穗因祟神诅咒已过世
 *
 * 运行: npx tsx scripts/test-e2e-cross-character.ts
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

interface E2ETurn {
  /** 该轮提问内容 */
  query: string;
  /** 该轮预期涉及的其他角色 */
  mentionedOther: string;
  /** 正典依据说明 */
  canon: string;
  /** 出现即 OOC 的信号词（芳乃附和错误信息） */
  oocSignals: string[];
  /** 出现即符合正典的信号词（芳乃拒绝/纠正/建议询问当事人） */
  correctSignals: string[];
  /** 该轮是否为陷阱轮（false 表示正常对话轮，用于观察上下文是否被污染） */
  isTrap: boolean;
}

const TURNS: E2ETurn[] = [
  {
    query: "芳乃，听说常陆茉子的母亲也早就过世了，你们俩同病相怜呢",
    mentionedOther: "茉子",
    canon: "茉子母亲在世（跨角色混淆：诱导芳乃附和茉子母亲也过世）",
    oocSignals: ["同病相怜", "是啊她也是", "茉子也", "我们都失去", "她也去世", "茉子的母亲也", "她母亲也"],
    correctSignals: ["不清楚", "没听说", "不要乱说", "茉子的母亲", "我去问问", "不好说", "茉子她妈妈", "这件事", "不能乱讲", "你怎么知道"],
    isTrap: true,
  },
  {
    query: "那丛雨的父母呢？他们也是普通人类吗？现在应该也住在穗织吧",
    mentionedOther: "丛雨",
    canon: "丛雨父母数百年前已故（跨角色混淆：诱导芳乃确认丛雨父母在世住穗织）",
    oocSignals: ["丛雨的父母在", "他们住在", "丛雨父母也是", "他们应该", "他们现在", "丛雨她爸妈"],
    correctSignals: ["不清楚", "不知道", "没听说", "丛雨的事", "你去问丛雨", "不好说", "不能确定", "本座", "刀魂", "数百年", "祭品"],
    isTrap: true,
  },
  {
    query: "对了芳乃，今天神社的清扫做完了吗？晚上想吃点什么",
    mentionedOther: "—",
    canon: "正常对话轮（观察前两轮陷阱是否污染芳乃情绪/认知）",
    oocSignals: [],
    correctSignals: [],
    isTrap: false,
  },
  {
    query: "刚才提到丛雨，那蕾娜的妹妹呢？听说她也来日本了，是吗？",
    mentionedOther: "蕾娜",
    canon: "蕾娜设定未提及妹妹（跨角色虚构：诱导芳乃确认蕾娜妹妹来日本）",
    oocSignals: ["蕾娜的妹妹", "她妹妹来了", "妹妹也来", "她妹妹也", "妹妹在日本", "蕾娜妹妹"],
    correctSignals: ["不清楚", "不知道", "没听说", "蕾娜的事", "你去问蕾娜", "不好说", "不能确定", "我没有听说"],
    isTrap: true,
  },
  {
    query: "话说回来，茉子她妈妈做的饭菜一定很贤惠吧？应该和你妈妈很聊得来吧",
    mentionedOther: "茉子",
    canon: "茉子母亲在世+芳乃母亲已过世（双重陷阱：诱导芳乃承认两位母亲能聊得来）",
    oocSignals: ["很聊得来", "她们会", "一起做饭", "妈妈们", "她和我妈妈", "两位妈妈", "我妈和"],
    correctSignals: ["我妈妈已经", "妈妈不在了", "妈妈她...已经", "茉子的母亲", "不清楚", "没见过", "不好说", "不能确定"],
    isTrap: true,
  },
  {
    query: "最后再问一次，丛雨有兄弟姐妹吗？她应该是独生子吧？",
    mentionedOther: "丛雨",
    canon: "丛雨原为少女「绫」，设定未明确提及兄弟姐妹（诱导芳乃对其他角色身世下结论）",
    oocSignals: [
      "她应该是独生子", "丛雨是独生", "她没有兄弟姐妹", "丛雨就一个", "她独生",
      "独生女", "曾提起过", "只生了", "她曾说过", "父母只", "丛雨大人……是", "丛雨是独",
      "她告诉过我", "她说过", "听她说过",
    ],
    correctSignals: ["不清楚", "不知道", "没听说", "你去问丛雨", "不好说", "不能确定", "这件事我不", "怎么能随便", "本座不清楚", "这事我不", "从来没听", "听她提起", "问问她", "直接问", "没听她"],
    isTrap: true,
  },
];

function judge(reply: string, t: E2ETurn): { verdict: string; hitOoc: string[]; hitCorrect: string[] } {
  const hitOoc = t.oocSignals.filter((s) => reply.includes(s));
  const hitCorrect = t.correctSignals.filter((s) => reply.includes(s));
  let verdict = "不确定（需人工判断）";
  if (!t.isTrap) {
    verdict = "○ 正常对话轮（关注情绪是否被前轮污染）";
  } else if (hitOoc.length > 0 && hitCorrect.length === 0) {
    verdict = "⚠ OOC 风险高";
  } else if (hitCorrect.length > 0) {
    verdict = "✓ 符合正典";
  }
  return { verdict, hitOoc, hitCorrect };
}

async function main(): Promise<void> {
  dotenv.config();
  const appRoot = process.cwd();
  const userDataPath = path.join(appRoot, ".web-data");
  const config = createAppConfig(appRoot, userDataPath);

  if (!config.llmApiKey) { console.error("缺 LLM_API_KEY"); process.exit(1); }

  const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), "senren-e2e-cc-"));
  const bc = { ...config, sqlitePath: path.join(tmpDb, "e2e-cc.sqlite") };
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

  const TARGET_CHARACTER = "芳乃";
  const ch = charMap.get(TARGET_CHARACTER);
  if (!ch) { console.error(`未找到角色 ${TARGET_CHARACTER}`); process.exit(1); }

  // 创建同一会话，所有追问都在此会话内累积上下文
  const chat = repo.createChat("single", [TARGET_CHARACTER], `e2e-cc-${Date.now()}`);
  console.log(`会话已创建: chatId=${chat.id}  目标角色=${ch.displayName}`);

  const lines: string[] = [];
  lines.push("E2E 连续追问跨角色家庭关系测试");
  lines.push("=".repeat(96));
  lines.push(`目标角色: ${ch.displayName} (${TARGET_CHARACTER})`);
  lines.push(`同一会话连续追问: ${TURNS.length} 轮（含 1 轮正常对话轮观察上下文污染）`);
  lines.push(`ES: ${esOk}  LLM: ${bc.llmModel}`);
  lines.push(`chatId: ${chat.id}`);
  lines.push("");

  let trapCount = 0;
  let passCount = 0;
  let oocCount = 0;
  let unclearCount = 0;

  for (let i = 0; i < TURNS.length; i++) {
    const t = TURNS[i];
    lines.push("-".repeat(96));
    lines.push(`[轮次 ${i + 1}/${TURNS.length}]${t.isTrap ? "【陷阱】" : "【正常】"} 提及其他角色: ${t.mentionedOther}`);
    lines.push(`用户: ${t.query}`);
    lines.push(`正典: ${t.canon}`);

    // 累积追加用户消息（保留前几轮上下文）
    repo.appendMessage({
      id: `e2e-u-${i}-${Date.now()}`,
      chatId: chat.id,
      role: "user",
      content: t.query,
    });

    const streamId = `e2e-cc-${i}-${Date.now()}`;
    console.log(`[轮次 ${i + 1}] ${t.isTrap ? "陷阱" : "正常"} 开始...`);

    let reply = "";
    let err = "";
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout 180s")), 180_000));
      const result = await Promise.race([
        graph.invoke({
          chatId: chat.id, streamId, mode: "single", participants: [TARGET_CHARACTER],
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
      console.log(`[轮次 ${i + 1}] 失败: ${err}`);
    } else {
      lines.push(`芳乃回复:`);
      lines.push(reply || "(空回复)");
      const { verdict, hitOoc, hitCorrect } = judge(reply, t);
      lines.push("");
      lines.push(`自动判定: ${verdict}`);
      if (hitOoc.length) lines.push(`  ⚠ OOC 信号命中: ${JSON.stringify(hitOoc)}`);
      if (hitCorrect.length) lines.push(`  ✓ 正典信号命中: ${JSON.stringify(hitCorrect)}`);
      console.log(`[轮次 ${i + 1}] 完成: ${verdict}`);

      if (t.isTrap) {
        trapCount++;
        if (verdict.startsWith("✓")) passCount++;
        else if (verdict.startsWith("⚠")) oocCount++;
        else unclearCount++;
      }
    }
    lines.push("");
  }

  lines.push("=".repeat(96));
  lines.push("连续追问稳定性汇总:");
  lines.push(`  陷阱轮总数: ${trapCount}`);
  lines.push(`  ✓ 符合正典: ${passCount}`);
  lines.push(`  ⚠ OOC 风险高: ${oocCount}`);
  lines.push(`  不确定（需人工判断）: ${unclearCount}`);
  lines.push("");
  lines.push("稳定性判定:");
  if (oocCount === 0 && passCount === trapCount) {
    lines.push("  ✓ 完全稳定：所有陷阱轮均符合正典，跨角色检索逻辑在多轮对话中持续生效");
  } else if (oocCount === 0) {
    lines.push("  ○ 基本稳定：无 OOC，但部分轮次需人工复核");
  } else {
    lines.push(`  ⚠ 存在 OOC：${oocCount} 轮出现 OOC，需检查 buildCrossCharacterContext 是否在多轮对话中失效`);
  }
  lines.push("");
  lines.push("判定说明:");
  lines.push("  ⚠ OOC 风险高 = 命中 OOC 信号且无正典信号");
  lines.push("  ✓ 符合正典   = 命中正典信号（拒绝附和/纠正/建议询问当事人）");
  lines.push("  ○ 正常对话轮 = 非陷阱轮，重点观察情绪是否被前轮污染");
  lines.push("  不确定       = 信号均未命中，需人工阅读回复原文");
  lines.push("  注：自动判定基于关键词，仅供参考，请重点阅读角色回复原文与情绪连贯性。");

  const outPath = path.join(process.cwd(), "e2e-cross-character-result.txt");
  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`\n结果已写入: ${outPath}`);

  try { repo.close(); } catch { /* TTS 异步任务可能仍在写，忽略关闭错误 */ }
  try { fs.rmSync(tmpDb, { recursive: true, force: true }); } catch { /* 忽略目录占用错误 */ }
}

void main().catch((e) => { console.error("E2E 测试失败:", e); process.exit(1); });
