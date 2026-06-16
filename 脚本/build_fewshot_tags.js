const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, '原始数据');
const OUT_DIR = path.join(ROOT_DIR, '索引数据');
const PLAYABLE_CHARACTERS = new Set(['丛雨', '芳乃', '茉子', '蕾娜']);
const CHARACTER_ALIAS_MAP = {
  '芦花姐': '芦花'
};

const configs = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'roleplay_configs.json'), 'utf-8'));

const TAG_CATEGORIES = {
  scene: ['自我介绍', '日常寒暄', '答疑解惑', '安慰关心', '争论反驳', '道谢道歉', '请求提议', '抱怨吐槽', '惊讶反应', '告别送行'],
  emotion: ['平静', '高兴得意', '害羞尴尬', '生气不满', '悲伤难过', '担忧焦虑', '困惑惊讶', '无奈接受'],
  function: ['设定说明', '主动提议', '开玩笑', '内心独白', '表达好感', '拒绝否认', '命令指示', '感叹']
};

function tagDialogue(text, character) {
  const tags = { scene: [], emotion: [], function: [], tone: [] };

  const cleaned = text.replace(/[「」『』（）()\[\]\s\\n]/g, '');

  if (/初次见面|我的名字|我叫|吾名|自我介绍|我叫|我叫/.test(cleaned)) {
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

function normalizeCharacter(name) {
  return CHARACTER_ALIAS_MAP[name] || name;
}

function getCharacterType(name, roleType) {
  if (PLAYABLE_CHARACTERS.has(name)) return 'playable';
  if (roleType === 'narrator') return 'narrator';
  if (name === '将臣') return 'default_user';
  return roleType || 'support';
}

function normalizeText(text) {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ ]+/g, ' ')
    .trim();
}

const allTags = [];
const allTagsSet = {};

Object.entries(configs).forEach(([charName, charData]) => {
  if (!charData.sample_dialogues) return;

  charData.sample_dialogues.forEach((dialogue, idx) => {
    const normalizedCharacter = normalizeCharacter(charName);
    const roleType = charData.role_type || 'unknown';
    const tags = tagDialogue(dialogue, charName);
    const entry = {
      sample_id: `sample_${normalizedCharacter}_${String(idx).padStart(3, '0')}`,
      source: 'roleplay_configs.sample_dialogues',
      character: normalizedCharacter,
      character_raw: charName,
      character_type: getCharacterType(normalizedCharacter, roleType),
      role_type: roleType,
      is_playable: PLAYABLE_CHARACTERS.has(normalizedCharacter),
      sample_index: idx,
      text: dialogue,
      text_norm: normalizeText(dialogue),
      text_length: normalizeText(dialogue).length,
      tags: tags,
      all_tags: [...tags.scene, ...tags.emotion, ...tags.function, ...tags.tone]
    };

    allTags.push(entry);

    entry.all_tags.forEach(t => {
      allTagsSet[t] = (allTagsSet[t] || 0) + 1;
    });
  });
});

const lines = allTags.map(obj => JSON.stringify(obj)).join('\n') + '\n';
fs.writeFileSync(path.join(OUT_DIR, 'fewshot_tags.jsonl'), lines, 'utf-8');
fs.writeFileSync(path.join(OUT_DIR, 'sample_tags.jsonl'), lines, 'utf-8');

console.log(`标注完成: ${allTags.length} 条 sample dialogue`);
console.log(`涉及角色: ${[...new Set(allTags.map(t => t.character))].join(', ')}`);
console.log(`标签种类: ${Object.keys(allTagsSet).length} 种`);
console.log('\n标签分布 (Top 20):');
Object.entries(allTagsSet)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([tag, count]) => {
    console.log(`  ${tag}: ${count}条`);
  });

console.log('\n已保存: fewshot_tags.jsonl, sample_tags.jsonl');
