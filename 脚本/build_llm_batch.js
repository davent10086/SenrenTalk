const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, '原始数据');
const OUT_DIR = path.join(ROOT_DIR, '索引数据');

console.log('=== LLM 批量处理脚本 ===');
console.log('此脚本需要配置 API 后运行。');
console.log('支持 OpenAI 兼容 API 或本地 LLM。\n');

const CONFIG = {
  apiBase: process.env.LLM_API_BASE || 'https://api.openai.com/v1',
  apiKey: process.env.LLM_API_KEY || 'sk-your-key-here',
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  batchSize: 20,
  delayMs: 500,
  temperature: 0.3
};

function loadJSONL(filename, dir) {
  const src = dir || OUT_DIR;
  const raw = fs.readFileSync(path.join(src, filename), 'utf-8');
  return raw.trim().split('\n').map(line => JSON.parse(line));
}

function saveJSONL(filename, arr) {
  const content = arr.map(obj => JSON.stringify(obj)).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, filename), content, 'utf-8');
}

async function callLLM(messages) {
  const response = await fetch(`${CONFIG.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.apiKey}`
    },
    body: JSON.stringify({
      model: CONFIG.model,
      messages: messages,
      temperature: CONFIG.temperature,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API 错误 (${response.status}): ${err}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

async function generateVernacular(dialogues) {
  console.log(`\n--- 生成口语化改写: ${dialogues.length} 条 ---`);

  const prompt = `你是GalGame《千恋万花》的本地化专家。请将以下角色对话改写为现代口语化中文，并附带一句话的语义说明。

改写规则：
1. 去掉「」『』等符号，改为自然口语
2. 保留角色的说话风格，但用现代白话表达
3. 古风词汇转为现代同义表达（如"本座"→"我"、"汝"→"你"、"便是"→"就是"）
4. 在末尾加一句括号说明这段对话的语义和作用

输出格式(JSON数组)：
[
  {"id": 0, "vernacular": "改写后的口语化表达 （说明这段对话是在什么场景下说的、表达了什么情绪）"},
  ...
]

对话列表：
${dialogues.map((d, i) => `${i}: [${d.character}] "${d.text}"`).join('\n')}`;

  const userMsg = dialogues.map((d, i) => `${i}: [${d.character}] "${d.text}"`).join('\n');

  const result = await callLLM([
    { role: 'system', content: '你是一个JSON输出助手。总是返回有效的JSON。' },
    { role: 'user', content: prompt }
  ]);

  return result;
}

async function generateTags(dialogues) {
  console.log(`\n--- 生成意图标签: ${dialogues.length} 条 ---`);

  const prompt = `请为以下《千恋万花》角色对话标注意图、情绪和场景标签。

标签体系：
- 场景类型: 自我介绍, 日常寒暄, 答疑解惑, 安慰关心, 争论反驳, 道谢道歉, 请求提议, 抱怨吐槽, 惊讶反应, 告别送行
- 情绪: 平静, 高兴得意, 害羞尴尬, 生气不满, 悲伤难过, 担忧焦虑, 困惑惊讶, 无奈接受
- 功能: 设定说明, 主动提议, 开玩笑, 内心独白, 表达好感, 拒绝否认, 命令指示, 感叹

输出格式(JSON数组)：
[
  {"id": 0, "scene": ["场景标签"], "emotion": ["情绪标签"], "function": ["功能标签"], "keywords": ["提取的关键词,用于BM25"]},
  ...
]

对话列表：
${dialogues.map((d, i) => `${i}: [${d.character}] "${d.text}"`).join('\n')}`;

  const result = await callLLM([
    { role: 'system', content: '你是一个JSON输出助手。总是返回有效的JSON。' },
    { role: 'user', content: prompt }
  ]);

  return result;
}

async function generateNarrationToCharacter(narrations, targetChar) {
  console.log(`\n--- 生成旁白角色化文本: ${narrations.length} 条, 目标角色: ${targetChar} ---`);

  const prompt = `请将以下《千恋万花》的旁白叙述，转化为从角色"${targetChar}"视角出发的描述性文本。每条旁白约50-100字的角色视角描述。

旁白列表：
${narrations.map((n, i) => `${i}: "${n}"`).join('\n')}

输出格式(JSON数组)：
[
  {"id": 0, "character_perspective": "从${targetChar}视角描述这段场景的文字"},
  ...
]`;

  const result = await callLLM([
    { role: 'system', content: '你是一个JSON输出助手。总是返回有效的JSON。' },
    { role: 'user', content: prompt }
  ]);

  return result;
}

async function processBatch(items, generateFn, outputFile, processFn) {
  const results = [];

  for (let i = 0; i < items.length; i += CONFIG.batchSize) {
    const batch = items.slice(i, i + CONFIG.batchSize);
    console.log(`  处理 ${i + 1}-${Math.min(i + CONFIG.batchSize, items.length)} / ${items.length}`);

    try {
      const batchResult = await generateFn(batch);
      const processed = processFn(batch, batchResult);
      results.push(...processed);
      console.log(`  ✓ 完成 ${processed.length} 条`);
    } catch (err) {
      console.error(`  ✗ 批次失败: ${err.message}`);
      console.log(`  重试中...`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const batchResult = await generateFn(batch);
        const processed = processFn(batch, batchResult);
        results.push(...processed);
        console.log(`  ✓ 重试成功 ${processed.length} 条`);
      } catch (err2) {
        console.error(`  ✗ 重试失败，跳过此批次`);
      }
    }

    saveJSONL(outputFile, results);
    console.log(`  已保存进度: ${results.length} 条`);

    await new Promise(r => setTimeout(r, CONFIG.delayMs));
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const task = args[0] || 'all';
  const targetChar = args[1] || null;

  console.log(`任务: ${task}`);
  console.log(`API: ${CONFIG.apiBase}`);
  console.log(`模型: ${CONFIG.model}\n`);

  if (task === 'vernacular' || task === 'all') {
    console.log('=== 任务1: 口语化改写 ===');
    const clean = loadJSONL('dialogues_clean.jsonl');
    const mainChars = ['丛雨', '芳乃', '茉子', '蕾娜', '将臣'];
    const toProcess = clean.filter(d => mainChars.includes(d.character));

    console.log(`主要角色对话: ${toProcess.length} 条 (来自 ${clean.length} 条清洗后数据)`);

    await processBatch(
      toProcess,
      generateVernacular,
      'dialogues_vernacular.jsonl',
      (batch, batchResult) => {
        return batchResult.map((r, i) => ({
          clean_id: batch[i].id,
          character: batch[i].character,
          original: batch[i].text,
          vernacular: r.vernacular
        }));
      }
    );
  }

  if (task === 'tags' || task === 'all') {
    console.log('\n=== 任务2: 意图标签标注 ===');
    const clean = loadJSONL('dialogues_clean.jsonl');

    await processBatch(
      clean,
      generateTags,
      'dialogue_tags.jsonl',
      (batch, batchResult) => {
        return batchResult.map((r, i) => ({
          clean_id: batch[i].id,
          character: batch[i].character,
          text: batch[i].text,
          scene: r.scene || [],
          emotion: r.emotion || [],
          function: r.function || [],
          keywords: r.keywords || []
        }));
      }
    );
  }

  if (task === 'narration' || task === 'all') {
    console.log('\n=== 任务3: 旁白角色化 ===');
    const all = loadJSONL('dialogues_chinese.jsonl', SRC_DIR);
    const narrations = all.filter(d => d.character === '旁白' && d.text.replace(/[「」『』\s\\n]/g, '').length >= 10);

    const chars = targetChar ? [targetChar] : ['丛雨', '芳乃', '茉子', '蕾娜', '将臣'];

    const allResults = [];
    for (const char of chars) {
      const relevant = narrations.filter(n => {
        return n.text.includes(char);
      });

      console.log(`角色 ${char}: ${relevant.length} 条相关旁白`);

      const results = await processBatch(
        relevant,
        (batch) => generateNarrationToCharacter(batch.map(n => n.text), char),
        `narration_${char}.jsonl`,
        (batch, batchResult) => {
          return batchResult.map((r, i) => ({
            dialogue_index: batch[i].id !== undefined ? batch[i].id : batch[i].dialogue_index,
            chapter: batch[i].chapter,
            target_character: char,
            original_narration: batch[i].text,
            character_perspective: r.character_perspective
          }));
        }
      );

      allResults.push(...results);
    }

    saveJSONL('narration_to_character.jsonl', allResults);
    console.log(`旁白角色化完成: ${allResults.length} 条`);
  }

  console.log('\n=== 全部完成 ===');
}

main().catch(err => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});