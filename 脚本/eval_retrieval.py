import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

from search_es import parse_bool_flag, parse_csv_arg, search_documents


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_EVAL_FILE = BASE_DIR / "索引数据" / "retrieval_eval.jsonl"


def load_jsonl(file_path: Path) -> List[dict]:
    rows: List[dict] = []
    with file_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def parse_k_values(value: str) -> List[int]:
    values = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        values.append(int(item))
    if not values:
        raise ValueError("必须提供至少一个 K 值，例如 1,3,5,10")
    return sorted(set(values))


def reciprocal_rank(found_rank: int, k: int) -> float:
    if found_rank <= 0 or found_rank > k:
        return 0.0
    return 1.0 / found_rank


def evaluate_example(result_hits: Sequence[dict], expected_ids: Sequence[str], k_values: Iterable[int]) -> Dict[str, Dict[str, float]]:
    expected_set = set(expected_ids)
    predicted_ids = [hit["source_id"] for hit in result_hits]
    metrics: Dict[str, Dict[str, float]] = {}

    for k in k_values:
        top_k = predicted_ids[:k]
        matched = [doc_id for doc_id in top_k if doc_id in expected_set]
        first_rank = 0
        for rank, doc_id in enumerate(top_k, start=1):
            if doc_id in expected_set:
                first_rank = rank
                break
        metrics[str(k)] = {
            "hit": 1.0 if matched else 0.0,
            "recall": len(set(matched)) / max(1, len(expected_set)),
            "mrr": reciprocal_rank(first_rank, k),
        }
    return metrics


def normalize_filters(row_filters: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row_filters or {})
    if "playable" in normalized:
        normalized["playable"] = parse_bool_flag(str(normalized["playable"]))
    return normalized


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="评估 ES 检索召回率")
    parser.add_argument("--eval-file", default=str(DEFAULT_EVAL_FILE), help="评测集 JSONL 文件")
    parser.add_argument("--query", help="单条查询文本")
    parser.add_argument("--expected-source-ids", help="单条查询的标准答案 source_id，逗号分隔")
    parser.add_argument("--mode", default="hybrid", choices=["bm25", "dense", "hybrid"], help="检索模式")
    parser.add_argument("--size", type=int, default=10, help="每条 query 返回的最大条数")
    parser.add_argument("--k", default="1,3,5,10", help="评估的 K 值，逗号分隔")
    parser.add_argument("--candidate-size", type=int, default=50, help="召回候选数")
    parser.add_argument("--character", help="按角色过滤")
    parser.add_argument("--record-type", help="按记录类型过滤，逗号分隔，例如 dialogue,passage")
    parser.add_argument("--character-type", help="按角色类型过滤，逗号分隔")
    parser.add_argument("--all-tags", help="按 all_tags 过滤，逗号分隔")
    parser.add_argument("--chapter", help="按章节过滤")
    parser.add_argument("--playable", help="是否只查可扮演角色，true/false")
    parser.add_argument("--json", action="store_true", help="输出完整 JSON 结果")
    return parser


def print_single_result(
    query: str,
    expected_ids: Sequence[str],
    result: Dict[str, Any],
    metrics: Dict[str, Dict[str, float]],
    k_values: Sequence[int],
) -> None:
    print(f"[QUERY] {query}")
    print(f"[EXPECTED] {list(expected_ids)}")
    print(f"[FILTERS] {json.dumps(result['filters'], ensure_ascii=False)}")
    for k in k_values:
        current = metrics[str(k)]
        print(
            f"[METRIC] K={k} | Hit@{k}={current['hit']:.4f} "
            f"| Recall@{k}={current['recall']:.4f} | MRR@{k}={current['mrr']:.4f}"
        )

    print("[HITS]")
    for hit in result["hits"][: max(k_values)]:
        is_match = "Y" if hit["source_id"] in expected_ids else "N"
        print(
            f"- rank={hit['rank']} | match={is_match} | source_id={hit['source_id']} "
            f"| character={hit['character']} | record_type={hit['record_type']}"
        )
        print(f"  text={hit['text']}")
        print(f"  tags={','.join(hit['all_tags'])}")


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()

    k_values = parse_k_values(args.k)
    max_k = max(k_values)

    if args.query:
        expected_ids = parse_csv_arg(args.expected_source_ids)
        if not expected_ids:
            raise ValueError("单条查询模式必须提供 --expected-source-ids 才能计算召回率。")

        result = search_documents(
            query=args.query,
            mode=args.mode,
            size=max(args.size, max_k),
            character=args.character,
            record_types=parse_csv_arg(args.record_type),
            playable=parse_bool_flag(args.playable),
            character_types=parse_csv_arg(args.character_type),
            tags=parse_csv_arg(args.all_tags),
            chapter=args.chapter,
            candidate_size=args.candidate_size,
        )
        metrics = evaluate_example(result["hits"], expected_ids, k_values)

        if args.json:
            print(
                json.dumps(
                    {
                        "query": args.query,
                        "expected_source_ids": expected_ids,
                        "metrics": metrics,
                        "hits": result["hits"][:max_k],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return

        print_single_result(args.query, expected_ids, result, metrics, k_values)
        return

    eval_file = Path(args.eval_file)
    rows = load_jsonl(eval_file)

    aggregate = {str(k): {"hit": 0.0, "recall": 0.0, "mrr": 0.0} for k in k_values}
    per_example = []

    for row in rows:
        filters = normalize_filters(row.get("filters", {}))
        result = search_documents(
            query=row["query"],
            mode=row.get("mode", args.mode),
            size=max(args.size, max_k),
            character=filters.get("character"),
            record_types=filters.get("record_types"),
            playable=filters.get("playable"),
            character_types=filters.get("character_types"),
            tags=filters.get("tags"),
            chapter=filters.get("chapter"),
            candidate_size=row.get("candidate_size", args.candidate_size),
        )

        expected_ids = row["expected_source_ids"]
        example_metrics = evaluate_example(result["hits"], expected_ids, k_values)
        for k in k_values:
            for metric_name in ("hit", "recall", "mrr"):
                aggregate[str(k)][metric_name] += example_metrics[str(k)][metric_name]

        matched_ids = [hit["source_id"] for hit in result["hits"] if hit["source_id"] in set(expected_ids)]
        per_example.append(
            {
                "id": row["id"],
                "query": row["query"],
                "mode": row.get("mode", args.mode),
                "expected_source_ids": expected_ids,
                "matched_source_ids": matched_ids,
                "metrics": example_metrics,
                "top_hits": [hit["source_id"] for hit in result["hits"][:max_k]],
            }
        )

    total = len(rows)
    summary = {
        str(k): {
            "hit_at_k": aggregate[str(k)]["hit"] / total,
            "recall_at_k": aggregate[str(k)]["recall"] / total,
            "mrr_at_k": aggregate[str(k)]["mrr"] / total,
        }
        for k in k_values
    }

    if args.json:
        print(
            json.dumps(
                {
                    "eval_file": str(eval_file),
                    "mode": args.mode,
                    "examples": total,
                    "summary": summary,
                    "details": per_example,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    print(f"[EVAL] 文件: {eval_file}")
    print(f"[EVAL] 样本数: {total}")
    for k in k_values:
        metrics = summary[str(k)]
        print(
            f"[METRIC] K={k} | Hit@{k}={metrics['hit_at_k']:.4f} "
            f"| Recall@{k}={metrics['recall_at_k']:.4f} | MRR@{k}={metrics['mrr_at_k']:.4f}"
        )

    print("[DETAILS]")
    for item in per_example:
        print(
            f"- {item['id']} | top_hits={item['top_hits']} | expected={item['expected_source_ids']} "
            f"| Recall@{k_values[-1]}={item['metrics'][str(k_values[-1])]['recall']:.4f}"
        )


if __name__ == "__main__":
    main()
