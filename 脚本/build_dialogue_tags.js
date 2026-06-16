const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, '索引数据');

const PLAYABLE_CHARACTERS = new Set(['丛雨', '芳乃', '茉子', '蕾娜']);

function loadJSON(filename) {
  return JSON.parse(fs.readFileSync(path.join(OUT_DIR, filename), 'utf-8'));
}

function loadJSONL(filename) {
  const fullPath = path.join(OUT_DIR, filename);
  const raw = fs.readFileSync(fullPath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map(line => JSON.parse(line));
}

function saveJSON(filename, obj) {
  fs.writeFileSync(path.join(OUT_DIR, filename), JSON.stringify(obj, null, 2), 'utf-8');
}

function saveJSONL(filename, arr) {
  const content = arr.map(obj => JSON.stringify(obj)).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, filename), content, 'utf-8');
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ ]+/g, ' ')
    .trim();
}

function tagText(text) {
  const tags = { scene: [], emotion: [], function: [], tone: [] };
  const cleaned = normalizeText(text).replace(/[「」『』（）()\[\]\s]/g, '');

  if (/初次见面|我的名字|我叫|吾名|自我介绍/.test(cleaned)) {
    tags.scene.push('自我介绍');
  }
  if (/你好|您好|好久没见|好久不见|最近过得怎么样|过得好|请多指教|请多关照/.test(cleaned)) {
    tags.scene.push('日常寒暄');
  }
  if (/是吗|什么|怎么回事|怎么了|为什么|真的吗|难不成/.test(cleaned)) {
    tags.scene.push('答疑解惑');
  }
  if (/没关系|不要在意|不用担|没事|放心|别担心|别难过|别哭/.test(cleaned)) {
    tags.scene.push('安慰关心');
  }
  if (/不是|不对|都说了|才不是|闭嘴|烦不烦|笨蛋|丑八怪|你再说/.test(cleaned)) {
    tags.scene.push('争论反驳');
  }
  if (/谢谢|抱歉|对不起|不好意思|感谢|道歉|致歉/.test(cleaned)) {
    tags.scene.push('道谢道歉');
  }
  if (/能不能|可以|帮忙|拜托|请求|希望|愿望|想请你|麻烦/.test(cleaned)) {
    tags.scene.push('请求提议');
  }
  if (/累死了|什么态度|真是的|太扯|怎么这样|这什么/.test(cleaned)) {
    tags.scene.push('抱怨吐槽');
  }
  if (/呀|哇|呃|啊.{0,2}[!！?？]|什么[!！]|怎么[!！]/.test(cleaned)) {
    tags.scene.push('惊讶反应');
  }
  if (/拜拜|再见|明天见|告辞|告辞了|我走了/.test(cleaned)) {
    tags.scene.push('告别送行');
  }

  if (/哈哈|开心|高兴|好开心|好感动|笑|嘻嘻|嘿嘿/.test(cleaned)) {
    tags.emotion.push('高兴得意');
  }
  if (/害羞|脸红|别看|转过头|不好意思/.test(cleaned)) {
    tags.emotion.push('害羞尴尬');
  }
  if (/生气|好气|烦|可恶|混蛋|笨蛋|闭嘴/.test(cleaned)) {
    tags.emotion.push('生气不满');
  }
  if (/难过|悲伤|伤心|哭|痛苦|寂寞|想.*[死哭]/.test(cleaned)) {
    tags.emotion.push('悲伤难过');
  }
  if (/担心|怎么办|会不会|万一|怕|可怕|吓/.test(cleaned)) {
    tags.emotion.push('担忧焦虑');
  }
  if (/呃|啊|什么|怎么|为什么|不.*可能|难以置信/.test(cleaned)) {
    tags.emotion.push('困惑惊讶');
  }
  if (/好吧|没办法|也罢|无奈|只能|只好/.test(cleaned)) {
    tags.emotion.push('无奈接受');
  }

  if (/传说|传说中|设定|规则|管理者|守护|神力|巫女|祟神|丛雨丸/.test(cleaned)) {
    tags.function.push('设定说明');
  }
  if (/要不|试试|想看|让.*看看|给你看|我.*教|让我.*来|来吧/.test(cleaned)) {
    tags.function.push('主动提议');
  }
  if (/玩笑|逗你|骗你|哄你|哈哈哈/.test(cleaned)) {
    tags.function.push('开玩笑');
  }
  if (/（|）|\(|\)/.test(text)) {
    tags.function.push('内心独白');
  }
  if (/喜欢|好感|爱|在意|好看|漂亮|可爱/.test(cleaned)) {
    tags.function.push('表达好感');
  }
  if (/不是|不对|没有|不行|不可以|不能|不是这样/.test(cleaned)) {
    tags.function.push('拒绝否认');
  }
  if (/快|去吧|过来|给|听.*说|别动|不要|不准/.test(cleaned)) {
    tags.function.push('命令指示');
  }
  if (/[!！]{2,}/.test(text) || /～/.test(text) || /啊$/.test(cleaned)) {
    tags.function.push('感叹');
  }

  if (/本座|吾|主人|便是|乃是|汝|之|罢了/.test(cleaned)) {
    tags.tone.push('古风');
  }
  if (/大人|先生|小姐|请|感谢|抱歉|非常/.test(cleaned)) {
    tags.tone.push('礼貌正式');
  }
  if (/真是|好吧|算了|无所谓|也罢/.test(cleaned)) {
    tags.tone.push('随意');
  }

  if (tags.scene.length === 0) tags.scene.push('日常寒暄');
  if (tags.emotion.length === 0) tags.emotion.push('平静');
  if (tags.function.length === 0) tags.function.push('日常对话');

  return tags;
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function buildTagRecord(item, options) {
  const tags = tagText(options.text);
  const textNorm = normalizeText(options.text);

  return {
    tag_id: options.tagId,
    source_file: options.sourceFile,
    source_type: options.sourceType,
    source_record_type: item.record_type,
    source_id: options.sourceId,
    character: item.character,
    character_raw: item.character_raw || item.character,
    character_type: item.character_type || 'support',
    is_playable: Boolean(item.is_playable),
    chapter: item.chapter || '',
    chapter_major: item.chapter_major ?? null,
    chapter_minor: item.chapter_minor ?? null,
    chapter_order: item.chapter_order ?? null,
    text: options.text,
    text_norm: textNorm,
    text_length: item.text_length || item.char_count || textNorm.length,
    tags,
    all_tags: dedupe([...tags.scene, ...tags.emotion, ...tags.function, ...tags.tone])
  };
}

function summarizeTagDistribution(records) {
  const counts = {};
  records.forEach((record) => {
    record.all_tags.forEach((tag) => {
      counts[tag] = (counts[tag] || 0) + 1;
    });
  });
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1])
  );
}

console.log('=== Step 1: 加载索引数据 ===');
const dialogues = loadJSONL('dialogues_clean.jsonl');
const passages = loadJSONL('dialogue_passages.jsonl');
const manifest = loadJSON('dataset_manifest.json');
console.log(`单句数: ${dialogues.length}`);
console.log(`段落数: ${passages.length}`);

console.log('\n=== Step 2: 生成全量单句标签 ===');
const dialogueTags = dialogues.map((item) => buildTagRecord(item, {
  tagId: `tag_${item.dialogue_id}`,
  sourceFile: 'dialogues_clean.jsonl',
  sourceType: 'dialogue',
  sourceId: item.dialogue_id,
  text: item.text
}));
saveJSONL('dialogue_tags.jsonl', dialogueTags);
console.log(`已保存: dialogue_tags.jsonl (${dialogueTags.length} 条)`);

console.log('\n=== Step 3: 生成全量段落标签 ===');
const passageTags = passages.map((item) => {
  const record = buildTagRecord(item, {
    tagId: `tag_${item.passage_id}`,
    sourceFile: 'dialogue_passages.jsonl',
    sourceType: 'passage',
    sourceId: item.passage_id,
    text: item.passage
  });

  record.source_dialogue_ids = item.source_dialogue_ids || [];
  record.source_dialogue_keys = item.source_dialogue_keys || [];
  record.source_count = item.source_count || record.source_dialogue_ids.length;
  record.sentence_count = item.sentence_count || 0;
  record.speaker_count = item.speaker_count || 1;

  return record;
});
saveJSONL('passage_tags.jsonl', passageTags);
console.log(`已保存: passage_tags.jsonl (${passageTags.length} 条)`);

console.log('\n=== Step 4: 生成标签清单 ===');
const tagManifest = {
  generated_at: new Date().toISOString(),
  schema_version: '1.0.0',
  playable_characters: [...PLAYABLE_CHARACTERS],
  files: {
    dialogue_tags: 'dialogue_tags.jsonl',
    passage_tags: 'passage_tags.jsonl'
  },
  counts: {
    dialogue_tags: dialogueTags.length,
    passage_tags: passageTags.length,
    playable_dialogue_tags: dialogueTags.filter(item => item.is_playable).length,
    playable_passage_tags: passageTags.filter(item => item.is_playable).length
  },
  top_tags: {
    dialogue_tags: Object.entries(summarizeTagDistribution(dialogueTags)).slice(0, 20),
    passage_tags: Object.entries(summarizeTagDistribution(passageTags)).slice(0, 20)
  }
};
saveJSON('tag_manifest.json', tagManifest);
console.log('已保存: tag_manifest.json');

console.log('\n=== Step 5: 更新 dataset_manifest.json ===');
manifest.generated_at = new Date().toISOString();
manifest.files = {
  ...manifest.files,
  dialogue_tags: 'dialogue_tags.jsonl',
  passage_tags: 'passage_tags.jsonl',
  tag_manifest: 'tag_manifest.json'
};
manifest.counts = {
  ...manifest.counts,
  dialogue_tags: dialogueTags.length,
  passage_tags: passageTags.length
};
saveJSON('dataset_manifest.json', manifest);
console.log('已更新: dataset_manifest.json');

console.log('\n=== 完成 ===');
console.log('产出文件: dialogue_tags.jsonl, passage_tags.jsonl, tag_manifest.json');
