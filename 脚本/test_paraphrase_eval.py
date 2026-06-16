"""
Paraphrase 评测数据集 + 模拟 LLM 标签提取的增强评测脚本

与原始评测数据的区别：
1. query 使用自然语言改写（paraphrase），而非原文截取
2. 模拟 LLM extractTags 的输出（基于 TAG_VOCAB 词表）
3. 标签可能不完全匹配文档标签（模拟真实场景的噪声）

评测目标：
- 对比优化前后（高频标签过滤 + minimum_should_match=2）在 paraphrase 查询下的效果
- 验证 Tag Match 在语义差异较大时是否能提供补充召回价值
"""
import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional

from elasticsearch import Elasticsearch
from urllib3.exceptions import InsecureRequestWarning

sys.path.insert(0, str(Path(__file__).resolve().parent))
from search_es import (
    create_es_client, build_filters, bm25_search, dense_search,
    rrf_fuse, rerank_by_embedding, _map_hit,
)

warnings.simplefilter("ignore", InsecureRequestWarning)

BASE_DIR = Path(__file__).resolve().parent.parent
DATASET_DIR = BASE_DIR / "索引数据"
ES_INDEX_NAME = os.environ.get("ES_INDEX_NAME", "senren_dialogues")

# 与生产代码一致的高频标签黑名单
HIGH_FREQUENCY_TAGS = {"日常对话", "日常寒暄", "平静"}

# 与 deepseek-service.ts TAG_VOCAB 一致的词表
TAG_VOCAB = {
    "emotion": ["困惑惊讶", "高兴得意", "担忧焦虑", "害羞尴尬", "生气不满", "悲伤难过"],
    "function": ["答疑解惑", "拒绝否认", "请求提议", "命令指示", "争论反驳", "道谢道歉", "表达好感", "设定说明", "安慰关心", "开玩笑", "抱怨吐槽"],
    "tone": ["古风", "礼貌正式", "随意"],
}


# ============================================================
# Paraphrase 评测数据集
# ============================================================

def build_paraphrase_eval_dataset() -> List[Dict[str, Any]]:
    """构造 paraphrase 评测数据集。

    每条用例包含：
    - id: 用例ID
    - query: 自然语言改写的查询（与原文语义相同但表述不同）
    - expected_source_ids: 期望命中的 source_id
    - filters: 检索过滤条件
    - simulated_tags: 模拟 LLM extractTags 的输出（可能包含高频标签）
    - original_text: 原始台词文本（用于参考对比）
    - difficulty: 难度等级 (easy/medium/hard)
      - easy: 改写保留了部分关键词
      - medium: 改写完全换词但语义相同
      - hard: 改写语义抽象，关键词完全不重叠
    """
    return [
        # === 芳乃 (3条) ===
        {
            "id": "para_001",
            "query": "她说这个诅咒跟别人没关系，叫我别瞎操心",
            "expected_source_ids": ["dlg_1593"],
            "filters": {"record_types": ["dialogue"], "character": "芳乃"},
            "simulated_tags": {"emotion": ["担忧焦虑"], "function": ["安慰关心"], "tone": []},
            "original_text": "诅咒是我自己的问题，你不用在意",
            "difficulty": "medium",
        },
        {
            "id": "para_002",
            "query": "芳乃有点慌了，追问我到底想表达什么",
            "expected_source_ids": ["dlg_2518"],
            "filters": {"record_types": ["dialogue"], "character": "芳乃"},
            "simulated_tags": {"emotion": ["害羞尴尬", "困惑惊讶"], "function": ["答疑解惑"], "tone": []},
            "original_text": "芳乃慌张地问我到底想说什么",
            "difficulty": "easy",
        },
        {
            "id": "para_003",
            "query": "她提到山上的邪祟归她管，不让我去冒险",
            "expected_source_ids": ["psg_00194"],
            "filters": {"record_types": ["passage"], "character": "芳乃"},
            "simulated_tags": {"emotion": ["担忧焦虑"], "function": ["命令指示", "设定说明"], "tone": []},
            "original_text": "诅咒是朝武家的问题，别上山，祸祟交给她处理",
            "difficulty": "hard",
        },

        # === 丛雨 (4条) ===
        {
            "id": "para_004",
            "query": "丛雨取笑我说武道精神得从心里头培养",
            "expected_source_ids": ["dlg_2801"],
            "filters": {"record_types": ["dialogue"], "character": "丛雨"},
            "simulated_tags": {"emotion": ["高兴得意"], "function": ["开玩笑"], "tone": []},
            "original_text": "丛雨调侃我要从内在培养武道精神",
            "difficulty": "easy",
        },
        {
            "id": "para_005",
            "query": "她让我别放在心上，说睡一觉就没事了",
            "expected_source_ids": ["dlg_2165"],
            "filters": {"record_types": ["dialogue"], "character": "丛雨"},
            "simulated_tags": {"emotion": [], "function": ["安慰关心"], "tone": []},
            "original_text": "丛雨安慰我说小事一桩，睡一觉就好了",
            "difficulty": "medium",
        },
        {
            "id": "para_006",
            "query": "丛雨很生气，说被我摸了胸这件事不能善罢甘休",
            "expected_source_ids": ["dlg_3148"],
            "filters": {"record_types": ["dialogue"], "character": "丛雨"},
            "simulated_tags": {"emotion": ["生气不满"], "function": ["争论反驳"], "tone": []},
            "original_text": "丛雨质问我居然摸了她的胸，说这事不能就这么算了",
            "difficulty": "medium",
        },
        {
            "id": "para_007",
            "query": "她解释说浴室要搞得很气派是因为净化仪式很重要",
            "expected_source_ids": ["psg_00303"],
            "filters": {"record_types": ["passage"], "character": "丛雨"},
            "simulated_tags": {"emotion": [], "function": ["设定说明"], "tone": []},
            "original_text": "丛雨说净化污秽很重要所以浴室规格不能马虎",
            "difficulty": "hard",
        },

        # === 茉子 (3条) ===
        {
            "id": "para_008",
            "query": "茉子打趣说我一看到穿校服的女生就走不动路了",
            "expected_source_ids": ["dlg_2511"],
            "filters": {"record_types": ["dialogue"], "character": "茉子"},
            "simulated_tags": {"emotion": ["高兴得意"], "function": ["开玩笑"], "tone": []},
            "original_text": "茉子调侃我看见穿校服的少女就心动了",
            "difficulty": "medium",
        },
        {
            "id": "para_009",
            "query": "茉子让我别在意那些事，赶紧出发吧",
            "expected_source_ids": ["dlg_2519"],
            "filters": {"record_types": ["dialogue"], "character": "茉子"},
            "simulated_tags": {"emotion": [], "function": ["命令指示"], "tone": ["随意"]},
            "original_text": "茉子让我别在意，说我们赶紧出发吧",
            "difficulty": "easy",
        },
        {
            "id": "para_010",
            "query": "她半开玩笑地问我是不是对制服有什么特殊癖好",
            "expected_source_ids": ["dlg_2511"],
            "filters": {"record_types": ["dialogue"], "character": "茉子"},
            "simulated_tags": {"emotion": ["高兴得意", "害羞尴尬"], "function": ["开玩笑", "表达好感"], "tone": []},
            "original_text": "茉子调侃我看见穿校服的少女就心动了",
            "difficulty": "hard",
        },

        # === 蕾娜 (3条) ===
        {
            "id": "para_011",
            "query": "蕾娜问我知不知道春日祭是什么活动",
            "expected_source_ids": ["dlg_40425"],
            "filters": {"record_types": ["dialogue"], "character": "蕾娜"},
            "simulated_tags": {"emotion": ["困惑惊讶"], "function": ["答疑解惑"], "tone": []},
            "original_text": "是关于春日祭的事情吗？",
            "difficulty": "medium",
        },
        {
            "id": "para_012",
            "query": "她有些不好意思地低下了头",
            "expected_source_ids": ["dlg_40248"],
            "filters": {"record_types": ["dialogue"], "character": "白狛"},
            "simulated_tags": {"emotion": ["害羞尴尬"], "function": [], "tone": []},
            "original_text": "……春日祭，将迎来重生？",
            "difficulty": "hard",
        },
        {
            "id": "para_013",
            "query": "蕾娜说前两天庆典的时候她见过我",
            "expected_source_ids": ["dlg_1587"],
            "filters": {"record_types": ["dialogue"], "character": "将臣"},
            "simulated_tags": {"emotion": [], "function": ["设定说明"], "tone": []},
            "original_text": "前天春日祭的时候我见过",
            "difficulty": "easy",
        },

        # === 廉太郎 (3条) ===
        {
            "id": "para_014",
            "query": "廉太郎抱怨回家吃饭太费劲了",
            "expected_source_ids": ["dlg_4047"],
            "filters": {"record_types": ["dialogue"], "character": "廉太郎"},
            "simulated_tags": {"emotion": ["生气不满"], "function": ["抱怨吐槽"], "tone": []},
            "original_text": "廉太郎说有人回家吃饭但太麻烦了",
            "difficulty": "easy",
        },
        {
            "id": "para_015",
            "query": "他说不想找个讨厌的人当妹妹，想要更可爱的",
            "expected_source_ids": ["dlg_325"],
            "filters": {"record_types": ["dialogue"], "character": "廉太郎"},
            "simulated_tags": {"emotion": ["生气不满"], "function": ["拒绝否认", "表达好感"], "tone": []},
            "original_text": "廉太郎嫌弃地说不想要讨厌鬼当妹妹，想要更可爱的",
            "difficulty": "medium",
        },
        {
            "id": "para_016",
            "query": "廉太郎感叹说为了避免修罗场只跟外来游客谈恋爱",
            "expected_source_ids": ["dlg_3929"],
            "filters": {"record_types": ["dialogue"], "character": "廉太郎"},
            "simulated_tags": {"emotion": ["担忧焦虑"], "function": ["设定说明"], "tone": []},
            "original_text": "廉太郎说为了避免修罗场只跟外来游客谈恋爱",
            "difficulty": "easy",
        },

        # === 芦花 (2条) ===
        {
            "id": "para_017",
            "query": "芦花姐感叹都四年没见了，我长得好高",
            "expected_source_ids": ["psg_00006"],
            "filters": {"record_types": ["passage"], "character": "芦花"},
            "simulated_tags": {"emotion": ["高兴得意", "困惑惊讶"], "function": ["感叹"], "tone": ["随意"]},
            "original_text": "是吗，都四年了……你长好高了呀，阿将",
            "difficulty": "medium",
        },
        {
            "id": "para_018",
            "query": "她说我越来越像个男子汉了，身体也结实了",
            "expected_source_ids": ["psg_00007"],
            "filters": {"record_types": ["passage"], "character": "芦花"},
            "simulated_tags": {"emotion": ["高兴得意"], "function": ["表达好感"], "tone": ["随意"]},
            "original_text": "你再长我就够不到你脑袋了……而且身体也长这么壮实，真是越来越像个大男人了",
            "difficulty": "hard",
        },

        # === 将臣 (2条) ===
        {
            "id": "para_019",
            "query": "我吐槽说这地方交通也太不方便了",
            "expected_source_ids": ["dlg_31"],
            "filters": {"record_types": ["dialogue"], "character": "将臣"},
            "simulated_tags": {"emotion": ["生气不满"], "function": ["抱怨吐槽"], "tone": []},
            "original_text": "这地方还是那么不方便啊",
            "difficulty": "easy",
        },
        {
            "id": "para_020",
            "query": "我心里暗想这服务态度也太差了吧",
            "expected_source_ids": ["dlg_14"],
            "filters": {"record_types": ["dialogue"], "character": "将臣"},
            "simulated_tags": {"emotion": ["生气不满"], "function": ["抱怨吐槽", "内心独白"], "tone": []},
            "original_text": "（这什么服务态度啊……）",
            "difficulty": "medium",
        },

        # === 包含高频标签的混合用例（验证过滤效果）===
        {
            "id": "para_021",
            "query": "她很有礼貌地跟我打招呼问好",
            "expected_source_ids": ["dlg_4"],
            "filters": {"record_types": ["dialogue"], "character": "司机"},
            "simulated_tags": {"emotion": [], "function": ["日常对话"], "tone": ["礼貌正式"]},
            "original_text": "先生您醒醒",
            "difficulty": "hard",
            "note": "function含高频标签'日常对话'，应被过滤",
        },
        {
            "id": "para_022",
            "query": "司机很客气地跟我寒暄",
            "expected_source_ids": ["dlg_16"],
            "filters": {"record_types": ["dialogue"], "character": "司机"},
            "simulated_tags": {"emotion": [], "function": ["道谢道歉"], "tone": ["礼貌正式"]},
            "original_text": "真的很抱歉",
            "difficulty": "hard",
            "note": "低频标签+高频tone标签组合",
        },
    ]


# ============================================================
# 检索函数（优化前 vs 优化后）
# ============================================================

def tags_to_list(tags_dict: Dict[str, List[str]]) -> List[str]:
    """将标签字典转为扁平列表"""
    return [
        *(tags_dict.get("scene", [])),
        *(tags_dict.get("emotion", [])),
        *(tags_dict.get("function", [])),
        *(tags_dict.get("tone", [])),
    ]


def search_original(
    es: Elasticsearch,
    query: str,
    size: int,
    character: Optional[str],
    record_types: Optional[List[str]],
    tags: Optional[List[str]],
) -> List[Dict[str, Any]]:
    """原始检索逻辑（不过滤高频标签，minimum_should_match=1）"""
    filters = build_filters(character=character, record_types=record_types)
    candidate_size = size * 3

    dense_results = dense_search(es, query, size=candidate_size, filters=filters)
    bm25_results = bm25_search(es, query, size=candidate_size, filters=filters)

    if tags:
        body = {
            "size": size,
            "query": {
                "bool": {
                    "filter": filters,
                    "should": [{"term": {"all_tags": t}} for t in tags],
                    "minimum_should_match": 1,
                }
            },
        }
        response = es.search(index=ES_INDEX_NAME, body=body)
        tag_results = [_map_hit(hit) for hit in response["hits"]["hits"]]
    else:
        tag_results = []

    fused = rrf_fuse([dense_results, bm25_results, tag_results], candidate_size)
    return rerank_by_embedding(query, fused, size)


def search_optimized(
    es: Elasticsearch,
    query: str,
    size: int,
    character: Optional[str],
    record_types: Optional[List[str]],
    tags: Optional[List[str]],
) -> List[Dict[str, Any]]:
    """优化后检索逻辑（过滤高频标签，minimum_should_match=min(2, len)）"""
    filters = build_filters(character=character, record_types=record_types)
    candidate_size = size * 3

    # 方案一：过滤高频标签
    filtered_tags = [t for t in (tags or []) if t not in HIGH_FREQUENCY_TAGS]

    dense_results = dense_search(es, query, size=candidate_size, filters=filters)
    bm25_results = bm25_search(es, query, size=candidate_size, filters=filters)

    # 方案二：minimum_should_match = min(2, len)
    if filtered_tags:
        min_match = min(2, len(filtered_tags))
        body = {
            "size": size,
            "query": {
                "bool": {
                    "filter": filters,
                    "should": [{"term": {"all_tags": t}} for t in filtered_tags],
                    "minimum_should_match": min_match,
                }
            },
        }
        response = es.search(index=ES_INDEX_NAME, body=body)
        tag_results = [_map_hit(hit) for hit in response["hits"]["hits"]]
    else:
        tag_results = []

    fused = rrf_fuse([dense_results, bm25_results, tag_results], candidate_size)
    return rerank_by_embedding(query, fused, size)


def compute_metrics(hits: List[Dict[str, Any]], expected_ids: List[str], k: int = 10) -> Dict[str, float]:
    """计算 Hit@1, Hit@k, MRR"""
    hit_ids = [h["source_id"] for h in hits[:k]]
    hit_at_1 = 1.0 if hit_ids and hit_ids[0] in expected_ids else 0.0
    hit_at_k = 0.0
    mrr = 0.0
    for i, hid in enumerate(hit_ids):
        if hid in expected_ids:
            hit_at_k = 1.0
            mrr = 1.0 / (i + 1)
            break
    return {"hit_at_1": hit_at_1, "hit_at_k": hit_at_k, "mrr": mrr}


# ============================================================
# 主评测流程
# ============================================================

def main():
    es = create_es_client()
    if not es.ping():
        print("ERROR: 无法连接到 Elasticsearch")
        return

    eval_cases = build_paraphrase_eval_dataset()
    print(f"ES 连接成功，索引: {ES_INDEX_NAME}")
    print(f"Paraphrase 评测用例数: {len(eval_cases)}")
    print()

    # 按难度统计
    difficulty_counts = {}
    for c in eval_cases:
        d = c.get("difficulty", "unknown")
        difficulty_counts[d] = difficulty_counts.get(d, 0) + 1
    print("难度分布:")
    for d, n in sorted(difficulty_counts.items()):
        print(f"  {d}: {n} 条")
    print()

    # 运行评测
    results = []
    orig_metrics = {"hit_at_1": [], "hit_at_10": [], "mrr": []}
    opt_metrics = {"hit_at_1": [], "hit_at_10": [], "mrr": []}

    # 按难度分组的指标
    by_difficulty = {}

    print("=" * 90)
    print("  Paraphrase 评测结果（优化前 vs 优化后）")
    print("=" * 90)
    print(f"{'ID':<12} {'难度':<8} {'原始H@1':<10} {'优化H@1':<10} {'原始H@10':<10} {'优化H@10':<10} {'原始MRR':<10} {'优化MRR':<10} {'变化':<8}")
    print("-" * 90)

    for case in eval_cases:
        query = case["query"]
        expected_ids = case["expected_source_ids"]
        filters = case.get("filters", {})
        character = filters.get("character")
        record_types = filters.get("record_types")
        tags_dict = case.get("simulated_tags", {})
        tags = tags_to_list(tags_dict)
        difficulty = case.get("difficulty", "unknown")

        try:
            orig_hits = search_original(es, query, 10, character, record_types, tags)
            opt_hits = search_optimized(es, query, 10, character, record_types, tags)

            om = compute_metrics(orig_hits, expected_ids)
            pm = compute_metrics(opt_hits, expected_ids)

            orig_metrics["hit_at_1"].append(om["hit_at_1"])
            orig_metrics["hit_at_10"].append(om["hit_at_k"])
            orig_metrics["mrr"].append(om["mrr"])
            opt_metrics["hit_at_1"].append(pm["hit_at_1"])
            opt_metrics["hit_at_10"].append(pm["hit_at_k"])
            opt_metrics["mrr"].append(pm["mrr"])

            # 按难度分组
            if difficulty not in by_difficulty:
                by_difficulty[difficulty] = {"orig": {"h1": [], "h10": [], "mrr": []}, "opt": {"h1": [], "h10": [], "mrr": []}}
            by_difficulty[difficulty]["orig"]["h1"].append(om["hit_at_1"])
            by_difficulty[difficulty]["orig"]["h10"].append(om["hit_at_k"])
            by_difficulty[difficulty]["orig"]["mrr"].append(om["mrr"])
            by_difficulty[difficulty]["opt"]["h1"].append(pm["hit_at_1"])
            by_difficulty[difficulty]["opt"]["h10"].append(pm["hit_at_k"])
            by_difficulty[difficulty]["opt"]["mrr"].append(pm["mrr"])

            # 标记变化
            delta = pm["hit_at_k"] - om["hit_at_k"]
            if delta > 0:
                change = "↑ 改善"
            elif delta < 0:
                change = "↓ 退化"
            elif pm["mrr"] > om["mrr"]:
                change = "↑ MRR"
            elif pm["mrr"] < om["mrr"]:
                change = "↓ MRR"
            else:
                change = "= 持平"

            print(f"{case['id']:<12} {difficulty:<8} {om['hit_at_1']:<10.1f} {pm['hit_at_1']:<10.1f} {om['hit_at_k']:<10.1f} {pm['hit_at_k']:<10.1f} {om['mrr']:<10.3f} {pm['mrr']:<10.3f} {change}")

            # 记录详细信息
            filtered_tags = [t for t in tags if t not in HIGH_FREQUENCY_TAGS]
            results.append({
                "id": case["id"],
                "difficulty": difficulty,
                "query": query,
                "original_text": case.get("original_text", ""),
                "tags_raw": tags,
                "tags_filtered": filtered_tags,
                "orig_hit_at_10": om["hit_at_k"],
                "opt_hit_at_10": pm["hit_at_k"],
                "orig_mrr": om["mrr"],
                "opt_mrr": pm["mrr"],
                "orig_top1": orig_hits[0]["source_id"] if orig_hits else "",
                "opt_top1": opt_hits[0]["source_id"] if opt_hits else "",
                "expected": expected_ids,
            })

        except Exception as e:
            print(f"[ERROR] {case['id']}: {e}")
            import traceback
            traceback.print_exc()

    # 汇总
    n = len(orig_metrics["hit_at_1"])
    print()
    print("=" * 90)
    print("  汇总统计")
    print("=" * 90)

    print(f"\n{'指标':<15} {'原始':<15} {'优化后':<15} {'变化':<15}")
    print("-" * 60)
    for metric_name, key in [("Hit@1", "hit_at_1"), ("Hit@10", "hit_at_10"), ("MRR", "mrr")]:
        o = sum(orig_metrics[key]) / n if n else 0
        p = sum(opt_metrics[key]) / n if n else 0
        delta = p - o
        arrow = "↑" if delta > 0 else ("↓" if delta < 0 else "=")
        print(f"{metric_name:<15} {o:<15.4f} {p:<15.4f} {arrow} {abs(delta):.4f}")

    # 按难度分组
    print(f"\n{'难度':<10} {'原始H@10':<12} {'优化H@10':<12} {'原始MRR':<12} {'优化MRR':<12} {'变化':<10}")
    print("-" * 68)
    for diff in ["easy", "medium", "hard"]:
        if diff not in by_difficulty:
            continue
        d = by_difficulty[diff]
        dn = len(d["orig"]["h10"])
        oh10 = sum(d["orig"]["h10"]) / dn if dn else 0
        ph10 = sum(d["opt"]["h10"]) / dn if dn else 0
        omrr = sum(d["orig"]["mrr"]) / dn if dn else 0
        pmrr = sum(d["opt"]["mrr"]) / dn if dn else 0
        delta = ph10 - oh10
        arrow = "↑" if delta > 0 else ("↓" if delta < 0 else "=")
        print(f"{diff:<10} {oh10:<12.4f} {ph10:<12.4f} {omrr:<12.4f} {pmrr:<12.4f} {arrow} {abs(delta):.4f}")

    # 标签过滤统计
    print()
    print("=" * 90)
    print("  标签过滤统计")
    print("=" * 90)
    total_raw_tags = 0
    total_filtered_tags = 0
    filtered_cases = 0
    for r in results:
        raw = len(r["tags_raw"])
        filtered = len(r["tags_filtered"])
        total_raw_tags += raw
        total_filtered_tags += filtered
        if raw > filtered:
            filtered_cases += 1
            removed = [t for t in r["tags_raw"] if t not in r["tags_filtered"]]
            print(f"  {r['id']}: 原始{raw}个 → 过滤后{filtered}个 (移除: {removed})")

    print(f"\n  总计: 原始标签 {total_raw_tags} 个 → 过滤后 {total_filtered_tags} 个")
    print(f"  受过滤影响的用例: {filtered_cases}/{len(results)}")

    # 差异用例详细分析
    print()
    print("=" * 90)
    print("  差异用例详细分析")
    print("=" * 90)
    diff_cases = [r for r in results if r["orig_hit_at_10"] != r["opt_hit_at_10"] or r["orig_mrr"] != r["opt_mrr"]]
    if diff_cases:
        for r in diff_cases:
            print(f"\n  {r['id']} ({r['difficulty']}): {r['query'][:40]}...")
            print(f"    原文: {r['original_text'][:50]}")
            print(f"    期望: {r['expected']}")
            print(f"    原始 Top1: {r['orig_top1']} | Hit@10: {r['orig_hit_at_10']} | MRR: {r['orig_mrr']:.3f}")
            print(f"    优化 Top1: {r['opt_top1']} | Hit@10: {r['opt_hit_at_10']} | MRR: {r['opt_mrr']:.3f}")
            print(f"    原始标签: {r['tags_raw']}")
            print(f"    过滤标签: {r['tags_filtered']}")
    else:
        print("  无差异用例（优化前后结果完全一致）")

    print()
    print("=" * 90)
    print("  评测完成")
    print("=" * 90)


if __name__ == "__main__":
    main()
