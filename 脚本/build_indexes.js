const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, '原始数据');
const OUT_DIR = path.join(ROOT_DIR, '索引数据');
const PLAYABLE_CHARACTERS = ['丛雨', '芳乃', '茉子', '蕾娜'];
const DEFAULT_USER_CHARACTER = '将臣';
const CHARACTER_ALIAS_MAP = {
  '芦花姐': '芦花'
};

function loadJSONL(filename) {
  const raw = fs.readFileSync(path.join(SRC_DIR, filename), 'utf-8');
  return raw.trim().split('\n').map(line => JSON.parse(line));
}

function saveJSONL(filename, arr) {
  const content = arr.map(obj => JSON.stringify(obj)).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, filename), content, 'utf-8');
}

function saveJSON(filename, obj) {
  fs.writeFileSync(path.join(OUT_DIR, filename), JSON.stringify(obj, null, 2), 'utf-8');
}

function normalizeCharacter(name) {
  return CHARACTER_ALIAS_MAP[name] || name;
}

function isPlayableCharacter(name) {
  return PLAYABLE_CHARACTERS.includes(name);
}

function getCharacterType(name) {
  if (isPlayableCharacter(name)) return 'playable';
  if (name === DEFAULT_USER_CHARACTER) return 'default_user';
  return 'support';
}

function isPurePunctuation(text) {
  const stripped = text.replace(/[「」『』（）\(\)\[\]。，、…\.\,\!\?\s　\r\n\-\—\\n\~\～]/g, '');
  return stripped.length < 2;
}

function isPureOnomatopoeia(text) {
  const onomatopoeia = ['嘎', '喵', '汪', '呜', '唔', '嗯', '啊', '呀', '哦', '呵', '嘻', '哈', '噗'];
  const stripped = text.replace(/[「」『』\!\?\s]/g, '');
  if (stripped.length <= 2) return false;
  const chars = [...stripped];
  const unique = [...new Set(chars)];
  return unique.every(c => onomatopoeia.includes(c)) || (unique.length <= 2 && chars.length <= 4);
}

function isMultiCharacter(name) {
  return name.includes('・') || name.includes('·');
}

function isNarrator(name) {
  return name === '旁白';
}

function getTextLength(text) {
  return text.replace(/[「」『』（）()\[\]\s\\n\-\—\~\～]/g, '').length;
}

function normalizeText(text) {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ ]+/g, ' ')
    .trim();
}

function parseChapter(chapter) {
  if (!chapter || !/^\d+-\d+$/.test(chapter)) {
    return { chapter_major: null, chapter_minor: null, chapter_order: null };
  }

  const [major, minor] = chapter.split('-').map(Number);
  return {
    chapter_major: major,
    chapter_minor: minor,
    chapter_order: major * 100 + minor
  };
}

function unique(arr) {
  return [...new Set(arr)];
}

function buildDialogueRecord(d, index) {
  const character = normalizeCharacter(d.character);
  return {
    id: index,
    dialogue_id: `dlg_${index}`,
    record_type: 'dialogue',
    source_index: index,
    character,
    character_raw: d.character,
    character_alias_applied: character !== d.character,
    character_type: getCharacterType(character),
    is_playable: isPlayableCharacter(character),
    text: d.text,
    text_norm: normalizeText(d.text),
    text_length: getTextLength(d.text),
    chapter: d.chapter || '',
    ...parseChapter(d.chapter)
  };
}

function buildCharacterAliases(clean) {
  const aliasToCanonical = {};
  const canonicalToAliases = {};

  clean.forEach((item) => {
    aliasToCanonical[item.character_raw] = item.character;
    if (!canonicalToAliases[item.character]) canonicalToAliases[item.character] = new Set();
    canonicalToAliases[item.character].add(item.character_raw);
  });

  Object.entries(CHARACTER_ALIAS_MAP).forEach(([alias, canonical]) => {
    aliasToCanonical[alias] = canonical;
    if (!canonicalToAliases[canonical]) canonicalToAliases[canonical] = new Set();
    canonicalToAliases[canonical].add(alias);
  });

  return {
    alias_to_canonical: Object.fromEntries(
      Object.entries(aliasToCanonical).sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
    ),
    canonical_to_aliases: Object.fromEntries(
      Object.entries(canonicalToAliases)
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
        .map(([canonical, aliases]) => [canonical, [...aliases].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))])
    ),
    playable_characters: PLAYABLE_CHARACTERS,
    default_user_character: DEFAULT_USER_CHARACTER
  };
}

console.log('=== Step 1: 加载 dialogues_chinese.jsonl ===');
const dialogues = loadJSONL('dialogues_chinese.jsonl');
console.log(`总对话数: ${dialogues.length}`);

console.log('\n=== Step 2: 数据清洗 ===');
const stats = {
  total: dialogues.length,
  removed_narrator: 0,
  removed_punctuation: 0,
  removed_short: 0,
  removed_onomatopoeia: 0,
  removed_multi: 0,
  kept: 0
};

const clean = [];
dialogues.forEach((d, i) => {
  let reason = null;

  if (isNarrator(d.character)) {
    reason = 'narrator';
    stats.removed_narrator++;
  } else if (isPurePunctuation(d.text)) {
    reason = 'punctuation';
    stats.removed_punctuation++;
  } else if (getTextLength(d.text) < 3) {
    reason = 'short';
    stats.removed_short++;
  } else if (isPureOnomatopoeia(d.text)) {
    reason = 'onomatopoeia';
    stats.removed_onomatopoeia++;
  } else if (isMultiCharacter(d.character)) {
    reason = 'multi';
    stats.removed_multi++;
  } else {
    clean.push(buildDialogueRecord(d, i));
    stats.kept++;
  }
});

console.log(`过滤统计:`);
console.log(`  删除旁白: ${stats.removed_narrator}`);
console.log(`  删除纯标点/无效: ${stats.removed_punctuation}`);
console.log(`  删除过短(<3字): ${stats.removed_short}`);
console.log(`  删除纯拟声词: ${stats.removed_onomatopoeia}`);
console.log(`  删除多人混合: ${stats.removed_multi}`);
console.log(`  保留: ${stats.kept}`);

saveJSONL('dialogues_clean.jsonl', clean);
console.log('已保存: dialogues_clean.jsonl');

console.log('\n=== Step 3: 构建对话段落(连续同角色3-5句合并) ===');
const passages = [];
let buffer = [];
let lastChapter = null;

clean.forEach((d) => {
  if (!d.chapter) return;
  if (d.chapter !== lastChapter && buffer.length > 0) {
    flushBuffer(buffer, passages);
    buffer = [];
  }
  lastChapter = d.chapter;

  if (buffer.length === 0) {
    buffer.push(d);
  } else if (buffer[buffer.length - 1].character === d.character) {
    if (buffer.length >= 5) {
      flushBuffer(buffer, passages);
      buffer = [d];
    } else {
      buffer.push(d);
    }
  } else {
    flushBuffer(buffer, passages);
    buffer = [d];
  }
});
flushBuffer(buffer, passages);

function flushBuffer(buf, result) {
  if (buf.length === 0) return;
  const filtered = buf.filter(d => getTextLength(d.text) >= 3);
  if (filtered.length >= 2) {
    const minLen = Math.min(...filtered.map(d => getTextLength(d.text)));
    if (minLen >= 3) {
      const charCounts = {};
      filtered.forEach(d => { charCounts[d.character] = (charCounts[d.character] || 0) + 1; });
      const dominant = Object.entries(charCounts).sort((a, b) => b[1] - a[1])[0][0];
      const passageText = filtered.map(d => d.text).join('');
      const chapter = buf[0].chapter;
      const passageId = `psg_${String(result.length + 1).padStart(5, '0')}`;

      result.push({
        passage_id: passageId,
        record_type: 'passage',
        character: dominant,
        character_type: getCharacterType(dominant),
        is_playable: isPlayableCharacter(dominant),
        character_raw_variants: unique(filtered.map(d => d.character_raw)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
        source_dialogue_ids: filtered.map(d => d.id),
        source_dialogue_keys: filtered.map(d => d.dialogue_id),
        source_count: filtered.length,
        speaker_count: unique(filtered.map(d => d.character)).length,
        passage: passageText,
        passage_norm: normalizeText(passageText),
        sentences: filtered.map(d => d.text),
        sentence_count: filtered.length,
        char_count: filtered.reduce((sum, d) => sum + d.text_length, 0),
        chapter,
        ...parseChapter(chapter)
      });
    }
  }
}

console.log(`生成段落数: ${passages.length}`);
console.log(`段落长度分布:`);
const lenGroups = { '2句': 0, '3句': 0, '4句': 0, '5句': 0 };
passages.forEach(p => {
  if (p.sentence_count === 2) lenGroups['2句']++;
  else if (p.sentence_count === 3) lenGroups['3句']++;
  else if (p.sentence_count === 4) lenGroups['4句']++;
  else if (p.sentence_count === 5) lenGroups['5句']++;
});
console.log(`  2句: ${lenGroups['2句']}, 3句: ${lenGroups['3句']}, 4句: ${lenGroups['4句']}, 5句: ${lenGroups['5句']}`);

saveJSONL('dialogue_passages.jsonl', passages);
console.log('已保存: dialogue_passages.jsonl');

console.log('\n=== Step 4: 统计角色对话分布 ===');
const charStats = {};
clean.forEach(d => {
  if (!d.chapter) return;
  if (!charStats[d.character]) {
    charStats[d.character] = {
      count: 0,
      chapters: new Set(),
      raw_names: new Set(),
      is_playable: isPlayableCharacter(d.character),
      character_type: getCharacterType(d.character)
    };
  }
  charStats[d.character].count++;
  charStats[d.character].chapters.add(d.chapter);
  charStats[d.character].raw_names.add(d.character_raw);
});

const sortedChars = Object.entries(charStats)
  .sort((a, b) => b[1].count - a[1].count);

console.log('Top 15 角色(清洗后):');
sortedChars.slice(0, 15).forEach(([name, info], i) => {
  console.log(`  ${i + 1}. ${name}: ${info.count}条, ${info.chapters.size}个章节`);
});

const charSummary = {};
sortedChars.forEach(([name, info]) => {
  charSummary[name] = {
    character: name,
    character_type: info.character_type,
    is_playable: info.is_playable,
    dialogue_count: info.count,
    chapter_count: info.chapters.size,
    chapters: [...info.chapters].sort(),
    raw_names: [...info.raw_names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  };
});
saveJSON('character_stats.json', charSummary);
console.log('已保存: character_stats.json');

console.log('\n=== Step 5: 生成角色别名、白名单与数据清单 ===');
const characterAliases = buildCharacterAliases(clean);
saveJSON('character_aliases.json', characterAliases);
console.log('已保存: character_aliases.json');

saveJSON('playable_characters.json', {
  playable_characters: PLAYABLE_CHARACTERS,
  default_user_character: DEFAULT_USER_CHARACTER,
  excluded_from_agent: [DEFAULT_USER_CHARACTER]
});
console.log('已保存: playable_characters.json');

saveJSON('dataset_manifest.json', {
  dataset_name: '千恋万花索引数据',
  generated_at: new Date().toISOString(),
  source_file: '原始数据/dialogues_chinese.jsonl',
  build_script: '脚本/build_indexes.js',
  schema_version: '2.0.0',
  defaults: {
    default_user_character: DEFAULT_USER_CHARACTER,
    playable_characters: PLAYABLE_CHARACTERS
  },
  counts: {
    raw_dialogues: dialogues.length,
    cleaned_dialogues: clean.length,
    passages: passages.length,
    normalized_characters: sortedChars.length,
    playable_dialogues: clean.filter(item => item.is_playable).length,
    playable_passages: passages.filter(item => item.is_playable).length
  },
  files: {
    dialogues_clean: 'dialogues_clean.jsonl',
    dialogue_passages: 'dialogue_passages.jsonl',
    character_stats: 'character_stats.json',
    character_aliases: 'character_aliases.json',
    playable_characters: 'playable_characters.json'
  }
});
console.log('已保存: dataset_manifest.json');

console.log('\n=== 完成 ===');
console.log('产出文件: dialogues_clean.jsonl, dialogue_passages.jsonl, character_stats.json, character_aliases.json, playable_characters.json, dataset_manifest.json');
