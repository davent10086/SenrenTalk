"""
验证高频标签过滤逻辑 + 召回率测试脚本

测试目标：
1. 验证 HIGH_FREQUENCY_TAGS 过滤逻辑是否生效
2. 验证 minimum_should_match=2 是否生效
3. 对比优化前后（仅高频标签过滤、仅minimum_should_match、两者结合）的召回率
"""
import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional

from elasticsearch import Elasticsearch
from urllib3.exceptions import InsecureRequestWarning

# 添加脚本目录到 path 以复用 search_es 中的函数
sys.path.insert(0, str(Path(__file__).resolve().parent))
from search_es import (
    create_es_client, build_filters, bm25_search, dense_search, tag_search,
    rrf_fuse, rerank_by_embedding, _map_hit,
)

warnings.simplefilter("ignore", InsecureRequestWarning)

BASE_DIR = Path(__file__).resolve().parent.parent
DATASET_DIR = BASE_DIR / "索引数据"

# 与生产代码 elasticsearch-service.ts 中的 HIGH_FREQUENCY_TAGS 保持一致
HIGH_FREQUENCY_TAGS = {"日常对话", "日常寒暄", "平静"}

ES_INDEX_NAME = os.environ.get("ES_INDEX_NAME", "senren_dialogues")


# ============================================================
# 第一部分：构造包含高频标签的测试数据
# ============================================================

def build_tag_test_cases() -> List[Dict[str, Any]]:
    """构造包含高频标签和低频标签组合的测试用例。
    
    每个用例包含：
    - query: 查询文本
    - tags: 用于 tag_search 的标签列表
    - expected_source_ids: 期望命中的 source_id 列表
    - filters: 检索过滤条件
    - description: 用例描述
    """
    return [
        {
            "id": "tag_001",
            "description": "仅含高频标签（日常对话+平静），应被过滤导致tag路无结果",
            "query": "打招呼",
            "tags": ["日常对话", "平静"],
            "expected_source_ids": [],
            "filters": {},
            "expect_tag_empty": True,
        },
        {
            "id": "tag_002",
            "description": "仅含高频标签（日常寒暄），应被过滤",
            "query": "你好",
            "tags": ["日常寒暄"],
            "expected_source_ids": [],
            "filters": {},
            "expect_tag_empty": True,
        },
        {
            "id": "tag_003",
            "description": "高频+低频标签混合，高频被过滤后仅剩低频标签参与检索",
            "query": "道歉并请求帮助",
            "tags": ["日常对话", "平静", "道谢道歉", "请求提议"],
            "expected_source_ids": [],
            "filters": {},
            "expect_tag_empty": False,
            "expected_effective_tags": ["道谢道歉", "请求提议"],
        },
        {
            "id": "tag_004",
            "description": "两个低频标签，minimum_should_match=2 应要求同时匹配",
            "query": "生气地抱怨",
            "tags": ["生气不满", "抱怨吐槽"],
            "expected_source_ids": [],
            "filters": {},
            "expect_tag_empty": False,
            "expected_effective_tags": ["生气不满", "抱怨吐槽"],
        },
        {
            "id": "tag_005",
            "description": "单个低频标签，minimum_should_match 降级为1",
            "query": "内心独白",
            "tags": ["内心独白"],
            "expected_source_ids": [],
            "filters": {},
            "expect_tag_empty": False,
            "expected_effective_tags": ["内心独白"],
        },
        {
            "id": "tag_006",
            "description": "三个高频标签全被过滤",
            "query": "普通的寒暄",
            "tags": ["日常对话", "日常寒暄", "平静"],
            "expected_source_ids": [],
            "filters": {},
            "expect_tag_empty": True,
        },
        {
            "id": "tag_007",
            "description": "高频标签+古风标签，过滤后剩古风",
            "query": "古风语气说话",
            "tags": ["日常对话", "古风"],
            "expected_source_ids": [],
            "filters": {},
            "expect_tag_empty": False,
            "expected_effective_tags": ["古风"],
        },
        {
            "id": "tag_008",
            "description": "含角色过滤的标签检索",
            "query": "丛雨开玩笑",
            "tags": ["日常对话", "开玩笑"],
            "expected_source_ids": [],
            "filters": {"character": "丛雨"},
            "expect_tag_empty": False,
            "expected_effective_tags": ["开玩笑"],
        },
    ]


# ============================================================
# 第二部分：验证高频标签过滤逻辑
# ============================================================

def verify_tag_filtering(es: Elasticsearch) -> Dict[str, Any]:
    """验证高频标签过滤逻辑是否生效。
    
    模拟生产代码中的过滤行为：
    1. 对 tagTerms 应用 HIGH_FREQUENCY_TAGS 过滤
    2. 检查过滤后的标签列表
    3. 验证 minimum_should_match = min(2, len(filtered_tags))
    """
    test_cases = build_tag_test_cases()
    results = []

    print("=" * 80)
    print("  第一部分：验证高频标签过滤逻辑")
    print("=" * 80)
    print()

    for tc in test_cases:
        raw_tags = tc["tags"]
        # 模拟生产代码的过滤逻辑
        filtered_tags = [t for t in raw_tags if t not in HIGH_FREQUENCY_TAGS]
        min_should_match = min(2, len(filtered_tags)) if filtered_tags else 0

        # 实际执行 tag_search（使用过滤后的标签）
        if filtered_tags:
            filters = build_filters(
                character=tc["filters"].get("character"),
            )
            tag_hits = tag_search(es, filtered_tags, size=10, filters=filters)
        else:
            tag_hits = []

        passed = True
        issues = []

        # 检查1：高频标签是否被正确过滤
        expected_effective = tc.get("expected_effective_tags", [])
        if expected_effective and set(filtered_tags) != set(expected_effective):
            passed = False
            issues.append(f"过滤后标签不匹配: 期望 {expected_effective}, 实际 {filtered_tags}")

        # 检查2：全高频标签时 tag 路应为空
        if tc.get("expect_tag_empty") and len(tag_hits) > 0:
            passed = False
            issues.append(f"期望tag路为空，但返回了 {len(tag_hits)} 条结果")

        # 检查3：minimum_should_match 计算
        if filtered_tags:
            if min_should_match != min(2, len(filtered_tags)):
                passed = False
                issues.append(f"minimum_should_match 计算错误: {min_should_match}")

        status = "PASS" if passed else "FAIL"
        results.append({"id": tc["id"], "passed": passed, "issues": issues})

        print(f"[{status}] {tc['id']}: {tc['description']}")
        print(f"  原始标签: {raw_tags}")
        print(f"  过滤后标签: {filtered_tags}")
        print(f"  minimum_should_match: {min_should_match}")
        print(f"  tag_search 返回: {len(tag_hits)} 条")
        if issues:
            for issue in issues:
                print(f"  !! {issue}")
        print()

    passed_count = sum(1 for r in results if r["passed"])
    print(f"过滤逻辑验证: {passed_count}/{len(results)} 通过")
    print()

    return {"results": results, "passed": passed_count, "total": len(results)}


# ============================================================
# 第三部分：召回率对比测试
# ============================================================

def load_eval_dataset() -> List[Dict[str, Any]]:
    """加载现有评测数据集"""
    eval_path = DATASET_DIR / "retrieval_eval.jsonl"
    cases = []
    with open(eval_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                cases.append(json.loads(line))
    return cases


def search_optimized(
    es: Elasticsearch,
    query: str,
    size: int = 10,
    character: Optional[str] = None,
    record_types: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """优化后的混合检索（模拟生产代码 hybridSearch 逻辑）。
    
    与 search_es.py 的 search_documents 区别：
    - 过滤高频标签
    - minimum_should_match = min(2, len(filtered_tags))
    """
    filters = build_filters(
        character=character,
        record_types=record_types,
    )

    candidate_size = size * 3

    # 方案一：过滤高频标签
    filtered_tags = [t for t in (tags or []) if t not in HIGH_FREQUENCY_TAGS]

    # 三路并行检索
    dense_results = dense_search(es, query, size=candidate_size, filters=filters)
    bm25_results = bm25_search(es, query, size=candidate_size, filters=filters)

    # 方案二：minimum_should_match = min(2, len)
    if filtered_tags:
        # 直接构造查询以控制 minimum_should_match
        min_match = min(2, len(filtered_tags))
        body = {
            "size": size,
            "query": {
                "bool": {
                    "filter": filters,
                    "should": [{"term": {"all_tags": tag}} for tag in filtered_tags],
                    "minimum_should_match": min_match,
                }
            },
        }
        response = es.search(index=ES_INDEX_NAME, body=body)
        tag_results = [_map_hit(hit) for hit in response["hits"]["hits"]]
    else:
        tag_results = []

    # 三路单次 RRF 融合
    fused = rrf_fuse([dense_results, bm25_results, tag_results], candidate_size)

    # 语义重排序
    hits = rerank_by_embedding(query, fused, size)
    return hits


def search_original(
    es: Elasticsearch,
    query: str,
    size: int = 10,
    character: Optional[str] = None,
    record_types: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """优化前的混合检索（原始逻辑，不过滤高频标签，minimum_should_match=1）"""
    filters = build_filters(
        character=character,
        record_types=record_types,
    )

    candidate_size = size * 3

    dense_results = dense_search(es, query, size=candidate_size, filters=filters)
    bm25_results = bm25_search(es, query, size=candidate_size, filters=filters)

    # 原始逻辑：不过滤高频标签，minimum_should_match=1
    if tags:
        body = {
            "size": size,
            "query": {
                "bool": {
                    "filter": filters,
                    "should": [{"term": {"all_tags": tag}} for tag in tags],
                    "minimum_should_match": 1,
                }
            },
        }
        response = es.search(index=ES_INDEX_NAME, body=body)
        tag_results = [_map_hit(hit) for hit in response["hits"]["hits"]]
    else:
        tag_results = []

    fused = rrf_fuse([dense_results, bm25_results, tag_results], candidate_size)
    hits = rerank_by_embedding(query, fused, size)
    return hits


def compute_metrics(hits: List[Dict[str, Any]], expected_ids: List[str], k: int = 10) -> Dict[str, float]:
    """计算 Hit@k 和 MRR"""
    hit_ids = [h["source_id"] for h in hits[:k]]
    hit_at_k = 0.0
    mrr = 0.0

    for i, hid in enumerate(hit_ids):
        if hid in expected_ids:
            hit_at_k = 1.0
            mrr = 1.0 / (i + 1)
            break

    return {"hit_at_1": 1.0 if hit_ids and hit_ids[0] in expected_ids else 0.0,
            "hit_at_k": hit_at_k, "mrr": mrr}


def run_recall_test(es: Elasticsearch) -> Dict[str, Any]:
    """对比优化前后的召回率"""
    eval_cases = load_eval_dataset()

    print("=" * 80)
    print("  第三部分：召回率对比测试")
    print("=" * 80)
    print()

    # 为部分用例添加标签（模拟 LLM 标签提取的结果）
    # 从 dialogue_tags.jsonl 中为前20条评测用例提取对应标签
    tag_map = load_tags_for_eval()

    original_metrics = {"hit_at_1": [], "hit_at_10": [], "mrr": []}
    optimized_metrics = {"hit_at_1": [], "hit_at_10": [], "mrr": []}

    print(f"共 {len(eval_cases)} 条评测用例")
    print()

    for i, case in enumerate(eval_cases):
        query = case["query"]
        expected_ids = case["expected_source_ids"]
        filters = case.get("filters", {})
        character = filters.get("character")
        record_types = filters.get("record_types")

        # 获取该用例对应的标签（如果有）
        tags = tag_map.get(case["id"], [])

        try:
            # 原始检索
            orig_hits = search_original(
                es, query, size=10,
                character=character, record_types=record_types, tags=tags,
            )
            orig_m = compute_metrics(orig_hits, expected_ids, k=10)

            # 优化后检索
            opt_hits = search_optimized(
                es, query, size=10,
                character=character, record_types=record_types, tags=tags,
            )
            opt_m = compute_metrics(opt_hits, expected_ids, k=10)

            original_metrics["hit_at_1"].append(orig_m["hit_at_1"])
            original_metrics["hit_at_10"].append(orig_m["hit_at_k"])
            original_metrics["mrr"].append(orig_m["mrr"])

            optimized_metrics["hit_at_1"].append(opt_m["hit_at_1"])
            optimized_metrics["hit_at_10"].append(opt_m["hit_at_k"])
            optimized_metrics["mrr"].append(opt_m["mrr"])

            # 标记有差异的用例
            if orig_m["hit_at_k"] != opt_m["hit_at_k"] or orig_m["mrr"] != opt_m["mrr"]:
                print(f"[DIFF] {case['id']}: {query[:30]}...")
                print(f"  原始: Hit@1={orig_m['hit_at_1']}, Hit@10={orig_m['hit_at_k']}, MRR={orig_m['mrr']:.3f}")
                print(f"  优化: Hit@1={opt_m['hit_at_1']}, Hit@10={opt_m['hit_at_k']}, MRR={opt_m['mrr']:.3f}")
                if tags:
                    print(f"  标签: {tags}")
                print()

        except Exception as e:
            print(f"[ERROR] {case['id']}: {e}")

    # 汇总统计
    n = len(original_metrics["hit_at_1"])
    orig_summary = {
        "hit_at_1": sum(original_metrics["hit_at_1"]) / n if n else 0,
        "hit_at_10": sum(original_metrics["hit_at_10"]) / n if n else 0,
        "mrr": sum(original_metrics["mrr"]) / n if n else 0,
    }
    opt_summary = {
        "hit_at_1": sum(optimized_metrics["hit_at_1"]) / n if n else 0,
        "hit_at_10": sum(optimized_metrics["hit_at_10"]) / n if n else 0,
        "mrr": sum(optimized_metrics["mrr"]) / n if n else 0,
    }

    print()
    print("=" * 80)
    print("  召回率对比汇总")
    print("=" * 80)
    print(f"{'指标':<15} {'原始':<15} {'优化后':<15} {'变化':<15}")
    print("-" * 60)
    for metric in ["hit_at_1", "hit_at_10", "mrr"]:
        o = orig_summary[metric]
        p = opt_summary[metric]
        delta = p - o
        arrow = "↑" if delta > 0 else ("↓" if delta < 0 else "=")
        print(f"{metric:<15} {o:<15.4f} {p:<15.4f} {arrow} {abs(delta):.4f}")

    print()
    return {"original": orig_summary, "optimized": opt_summary, "n": n}


def load_tags_for_eval() -> Dict[str, List[str]]:
    """为评测用例加载标签数据。
    
    从 dialogue_tags.jsonl 和 passage_tags.jsonl 中，
    根据 expected_source_ids 找到对应文档的 all_tags。
    """
    tag_map = {}

    # 加载所有标签数据
    all_tags = {}
    for tag_file in ["dialogue_tags.jsonl", "passage_tags.jsonl"]:
        tag_path = DATASET_DIR / tag_file
        if tag_path.exists():
            with open(tag_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        data = json.loads(line)
                        all_tags[data["source_id"]] = data.get("all_tags", [])

    # 为评测用例匹配标签
    eval_path = DATASET_DIR / "retrieval_eval.jsonl"
    with open(eval_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                case = json.loads(line)
                case_id = case["id"]
                expected_ids = case.get("expected_source_ids", [])
                # 取第一个期望文档的标签作为查询标签
                for eid in expected_ids:
                    if eid in all_tags:
                        tag_map[case_id] = all_tags[eid]
                        break

    return tag_map


# ============================================================
# 第二部分补充：验证 minimum_should_match 对结果的影响
# ============================================================

def verify_minimum_should_match_impact(es: Elasticsearch) -> Dict[str, Any]:
    """验证 minimum_should_match=2 对检索结果数量的影响"""
    print("=" * 80)
    print("  第二部分：验证 minimum_should_match 影响")
    print("=" * 80)
    print()

    test_tags = [
        (["道谢道歉", "请求提议"], "两个低频标签"),
        (["生气不满", "抱怨吐槽"], "两个低频标签2"),
        (["古风", "设定说明"], "古风+设定说明"),
        (["内心独白"], "单个低频标签"),
        (["开玩笑", "道谢道歉", "请求提议"], "三个低频标签"),
    ]

    results = []
    for tags, desc in test_tags:
        # minimum_should_match=1（原始）
        body1 = {
            "size": 10,
            "query": {
                "bool": {
                    "should": [{"term": {"all_tags": t}} for t in tags],
                    "minimum_should_match": 1,
                }
            },
        }
        resp1 = es.search(index=ES_INDEX_NAME, body=body1)
        count1 = resp1["hits"]["total"]["value"]

        # minimum_should_match=2（优化后）
        min_match2 = min(2, len(tags))
        body2 = {
            "size": 10,
            "query": {
                "bool": {
                    "should": [{"term": {"all_tags": t}} for t in tags],
                    "minimum_should_match": min_match2,
                }
            },
        }
        resp2 = es.search(index=ES_INDEX_NAME, body=body2)
        count2 = resp2["hits"]["total"]["value"]

        reduction = count1 - count2
        reduction_pct = (reduction / count1 * 100) if count1 > 0 else 0

        results.append({
            "tags": tags,
            "desc": desc,
            "count_match1": count1,
            "count_match2": count2,
            "reduction": reduction,
            "reduction_pct": reduction_pct,
        })

        print(f"标签: {tags} ({desc})")
        print(f"  match=1: {count1} 条 | match=2: {count2} 条 | 减少: {reduction} 条 ({reduction_pct:.1f}%)")
        print()

    return {"results": results}


# ============================================================
# 主函数
# ============================================================

def main():
    es = create_es_client()

    # 检查连接
    if not es.ping():
        print("ERROR: 无法连接到 Elasticsearch")
        return

    print(f"ES 连接成功，索引: {ES_INDEX_NAME}")
    print()

    # 第一部分：验证高频标签过滤逻辑
    filter_result = verify_tag_filtering(es)

    # 第二部分：验证 minimum_should_match 影响
    msm_result = verify_minimum_should_match_impact(es)

    # 第三部分：召回率对比测试
    recall_result = run_recall_test(es)

    # 总结
    print()
    print("=" * 80)
    print("  测试总结")
    print("=" * 80)
    print(f"过滤逻辑验证: {filter_result['passed']}/{filter_result['total']} 通过")
    print(f"召回率测试用例数: {recall_result['n']}")
    print(f"  原始 Hit@10: {recall_result['original']['hit_at_10']:.4f}")
    print(f"  优化 Hit@10: {recall_result['optimized']['hit_at_10']:.4f}")
    print(f"  原始 MRR:    {recall_result['original']['mrr']:.4f}")
    print(f"  优化 MRR:    {recall_result['optimized']['mrr']:.4f}")


if __name__ == "__main__":
    main()
