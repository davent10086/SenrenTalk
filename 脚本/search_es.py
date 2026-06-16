import argparse
import json
import math
import os
import re
import urllib.request
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional

from elasticsearch import Elasticsearch
from urllib3.exceptions import InsecureRequestWarning


BASE_DIR = Path(__file__).resolve().parent.parent

ES_URL = os.environ.get("ES_URL") or os.environ.get("ES_NODE") or "https://127.0.0.1:9200/"
ES_USERNAME = os.environ.get("ES_USERNAME") or os.environ.get("ES_USER") or "elastic"
ES_PASSWORD = os.environ.get("ES_PASSWORD") or "Lijunwei111"
ES_INDEX_NAME = os.environ.get("ES_INDEX_NAME", "senren_dialogues")

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL_NAME = os.environ.get("OLLAMA_MODEL_NAME", "bge-m3:latest")
TEXT_MAX_LENGTH = int(os.environ.get("TEXT_MAX_LENGTH", "512"))
VECTOR_CANDIDATE_SIZE = int(os.environ.get("VECTOR_CANDIDATE_SIZE", "50"))
RRF_K = int(os.environ.get("RRF_K", "60"))


def create_es_client() -> Elasticsearch:
    warnings.simplefilter("ignore", InsecureRequestWarning)
    return Elasticsearch(
        ES_URL,
        basic_auth=(ES_USERNAME, ES_PASSWORD),
        verify_certs=False,
        ssl_show_warn=False,
        request_timeout=120,
    )


def strip_outer_quotes(text: str) -> str:
    quote_pairs = {
        "「": "」",
        "『": "』",
        "“": "”",
        '"': '"',
        "'": "'",
    }
    stripped = text.strip()
    if len(stripped) < 2:
        return stripped

    opening = stripped[0]
    closing = stripped[-1]
    expected_closing = quote_pairs.get(opening)
    if expected_closing and closing == expected_closing:
        return stripped[1:-1].strip()
    return stripped


def normalize_embedding_text(text: str) -> str:
    cleaned = strip_outer_quotes(text)
    cleaned = re.sub(r'[「」『』“”"]+', " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def get_ollama_embedding(query_text: str) -> List[float]:
    raw_text = query_text[:TEXT_MAX_LENGTH]
    candidate_texts = [raw_text]
    normalized = normalize_embedding_text(raw_text)
    if normalized and normalized != raw_text:
        candidate_texts.append(normalized)

    last_error: Optional[Exception] = None
    for text in candidate_texts:
        payload = json.dumps({"model": OLLAMA_MODEL_NAME, "input": [text]}).encode("utf-8")
        request = urllib.request.Request(
            f"{OLLAMA_HOST.rstrip('/')}/api/embed",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = json.loads(response.read().decode("utf-8"))
            embeddings = data.get("embeddings") or []
            if len(embeddings) != 1:
                raise RuntimeError("Ollama embedding 返回结果异常。")
            return embeddings[0]
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    raise RuntimeError(f"查询向量生成失败: {last_error}")


def parse_csv_arg(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def build_filters(
    character: Optional[str] = None,
    record_types: Optional[List[str]] = None,
    playable: Optional[bool] = None,
    character_types: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    chapter: Optional[str] = None,
) -> List[dict]:
    filters: List[dict] = []
    if character:
        filters.append({"term": {"character": character}})
    if record_types:
        filters.append({"terms": {"record_type": record_types}})
    if playable is not None:
        filters.append({"term": {"is_playable": playable}})
    if character_types:
        filters.append({"terms": {"character_type": character_types}})
    if tags:
        filters.append({"terms": {"all_tags": tags}})
    if chapter:
        filters.append({"term": {"chapter": chapter}})
    return filters


def _map_hit(hit: dict) -> dict:
    """将 ES 原始 hit 映射为统一的文档格式。"""
    source = hit.get("_source", {})
    return {
        "source_id": source.get("source_id", hit.get("_id", "")),
        "record_type": source.get("record_type", "dialogue"),
        "character": source.get("character", ""),
        "character_type": source.get("character_type", ""),
        "is_playable": source.get("is_playable"),
        "chapter": source.get("chapter"),
        "all_tags": source.get("all_tags", []),
        "tags": source.get("tags", {}),
        "source_dialogue_keys": source.get("source_dialogue_keys", []),
        "text": source.get("text", ""),
        "score": hit.get("_score", 0),
    }


def rrf_fuse(result_sets: List[List[dict]], limit: int, rrf_k: int = 60) -> List[dict]:
    """RRF 融合：对多路检索结果去重并融合排序，与生产代码 rrfFuse 一致。

    公式: score += 1 / (rrf_k + rank + 1)，rank 从 0 开始。
    """
    scores: Dict[str, float] = {}
    docs: Dict[str, dict] = {}

    for results in result_sets:
        for rank, doc in enumerate(results):
            doc_id = doc["source_id"]
            docs[doc_id] = doc
            scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (rrf_k + rank + 1)

    return [
        docs[doc_id]
        for doc_id in sorted(scores, key=scores.get, reverse=True)[:limit]
        if doc_id in docs
    ]


def bm25_search(
    es: Elasticsearch,
    query: str,
    size: int,
    filters: Optional[List[dict]] = None,
    bm25_fields: Optional[List[str]] = None,
) -> List[dict]:
    """BM25 全文检索，字段权重与生产代码对齐。"""
    if bm25_fields is None:
        bm25_fields = ["text^2", "text_norm", "all_tags"]
    body = {
        "size": size,
        "query": {
            "bool": {
                "must": [
                    {
                        "multi_match": {
                            "query": query,
                            "fields": bm25_fields,
                            "type": "best_fields",
                        }
                    }
                ],
                "filter": filters or [],
            }
        },
    }
    response = es.search(index=ES_INDEX_NAME, body=body)
    return [_map_hit(hit) for hit in response["hits"]["hits"]]


def dense_search(
    es: Elasticsearch,
    query: str,
    size: int,
    filters: Optional[List[dict]] = None,
    candidate_size: Optional[int] = None,
) -> List[dict]:
    """稠密向量 kNN 检索，与生产代码 runHybridQuery 中的 knn 查询对齐。"""
    query_vector = get_ollama_embedding(query)
    num_candidates = (size * 10) if candidate_size is None else max(size, candidate_size)
    body: dict = {
        "size": size,
        "knn": {
            "field": "dense_vector",
            "query_vector": query_vector,
            "k": size,
            "num_candidates": num_candidates,
        },
    }
    if filters:
        body["knn"]["filter"] = {"bool": {"filter": filters}}
    response = es.search(index=ES_INDEX_NAME, body=body)
    return [_map_hit(hit) for hit in response["hits"]["hits"]]


def tag_search(
    es: Elasticsearch,
    tags: List[str],
    size: int,
    filters: Optional[List[dict]] = None,
) -> List[dict]:
    """标签匹配检索，与生产代码 hybridSearch 中的 tag 查询对齐。"""
    if not tags:
        return []
    body = {
        "size": size,
        "query": {
            "bool": {
                "filter": filters or [],
                "should": [{"term": {"all_tags": tag}} for tag in tags],
                "minimum_should_match": 1,
            }
        },
    }
    response = es.search(index=ES_INDEX_NAME, body=body)
    return [_map_hit(hit) for hit in response["hits"]["hits"]]


def rerank_by_embedding(
    query: str,
    candidates: List[dict],
    top_k: int,
) -> List[dict]:
    """语义重排序：对候选文档重新计算与 query 的余弦相似度，按新分数排序截断。

    与生产代码 rerankByEmbedding 一致。
    """
    if len(candidates) <= top_k:
        return candidates

    try:
        query_vector = get_ollama_embedding(query)
    except Exception:
        return candidates[:top_k]

    texts = [doc.get("text", "") for doc in candidates]
    doc_vectors = _embed_many(texts)

    scored = []
    for doc, doc_vec in zip(candidates, doc_vectors):
        if not doc_vec:
            scored.append({**doc, "score": 0})
            continue
        dot = sum(a * b for a, b in zip(doc_vec, query_vector))
        norm_a = math.sqrt(sum(v * v for v in doc_vec))
        norm_b = math.sqrt(sum(v * v for v in query_vector))
        cosine = dot / (norm_a * norm_b) if norm_a > 0 and norm_b > 0 else 0
        scored.append({**doc, "score": cosine})

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


def _embed_many(texts: List[str]) -> List[Optional[List[float]]]:
    """批量生成向量，逐条调用 Ollama embed API。"""
    results: List[Optional[List[float]]] = []
    for text in texts:
        try:
            vec = get_ollama_embedding(text)
            results.append(vec)
        except Exception:
            results.append(None)
    return results


def run_hybrid_query(
    es: Elasticsearch,
    query: str,
    size: int,
    filters: Optional[List[dict]] = None,
    bm25_fields: Optional[List[str]] = None,
) -> List[dict]:
    """双路混合查询（Dense kNN + BM25），RRF 融合，与生产代码 runHybridQuery 对齐。

    返回 topK*2 条候选，供外部与 Tag 结果再次融合。
    """
    candidate_size = size * 2

    dense_results = dense_search(es, query, candidate_size, filters=filters)
    bm25_results = bm25_search(es, query, candidate_size, filters=filters, bm25_fields=bm25_fields)

    return rrf_fuse([dense_results, bm25_results], candidate_size)


def search_documents(
    query: str,
    mode: str = "hybrid",
    size: int = 10,
    character: Optional[str] = None,
    record_types: Optional[List[str]] = None,
    playable: Optional[bool] = None,
    character_types: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    chapter: Optional[str] = None,
    candidate_size: Optional[int] = None,
) -> Dict[str, Any]:
    """ES 三路混合检索 + 单次 RRF 融合 + 语义重排序，与生产代码 hybridSearch 完全对齐。

    流程：
      1. Dense (kNN) + BM25 + Tag 三路并行检索
      2. 三路单次 RRF 融合 → topK*3 候选
      3. 语义重排序（rerankByEmbedding）→ 取 topK
    """
    es = create_es_client()
    filters = build_filters(
        character=character,
        record_types=record_types,
        playable=playable,
        character_types=character_types,
        tags=None,  # tags 不作为 filter，而是走 tag_search
        chapter=chapter,
    )

    candidate_size = candidate_size or (size * 3)

    if mode == "bm25":
        hits = bm25_search(es, query, size=size, filters=filters)
    elif mode == "dense":
        hits = dense_search(es, query, size=size, filters=filters, candidate_size=candidate_size)
    elif mode == "hybrid":
        # 三路并行检索
        dense_results = dense_search(es, query, size=candidate_size, filters=filters)
        bm25_results = bm25_search(es, query, size=candidate_size, filters=filters, bm25_fields=["text^2", "text_norm", "all_tags"])
        tag_results = tag_search(es, tags or [], size=size, filters=filters)

        # 三路单次 RRF 融合
        fused = rrf_fuse([dense_results, bm25_results, tag_results], candidate_size)

        # 语义重排序
        hits = rerank_by_embedding(query, fused, size)
    else:
        raise ValueError(f"不支持的检索模式: {mode}")

    formatted_hits = []
    for rank, hit in enumerate(hits, start=1):
        formatted_hits.append(
            {
                "rank": rank,
                "source_id": hit.get("source_id", ""),
                "score": hit.get("score", 0),
                "record_type": hit.get("record_type", ""),
                "character": hit.get("character", ""),
                "character_type": hit.get("character_type", ""),
                "is_playable": hit.get("is_playable"),
                "chapter": hit.get("chapter"),
                "all_tags": hit.get("all_tags", []),
                "source_dialogue_keys": hit.get("source_dialogue_keys", []),
                "text": hit.get("text", ""),
            }
        )

    return {
        "query": query,
        "mode": mode,
        "size": size,
        "filters": {
            "character": character,
            "record_types": record_types or [],
            "playable": playable,
            "tags": tags or [],
            "chapter": chapter,
        },
        "hits": formatted_hits,
    }


def parse_bool_flag(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes", "y"}:
        return True
    if normalized in {"false", "0", "no", "n"}:
        return False
    raise ValueError("--playable 只支持 true/false")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="搜索 ES 中的对话与段落索引")
    parser.add_argument("--query", required=True, help="查询文本")
    parser.add_argument("--mode", default="hybrid", choices=["bm25", "dense", "hybrid"], help="检索模式")
    parser.add_argument("--size", type=int, default=10, help="返回条数")
    parser.add_argument("--candidate-size", type=int, default=VECTOR_CANDIDATE_SIZE, help="召回候选数")
    parser.add_argument("--character", help="按角色过滤")
    parser.add_argument("--record-type", help="按记录类型过滤，逗号分隔，例如 dialogue,passage")
    parser.add_argument("--character-type", help="按角色类型过滤，逗号分隔")
    parser.add_argument("--all-tags", help="按 all_tags 过滤，逗号分隔")
    parser.add_argument("--chapter", help="按章节过滤")
    parser.add_argument("--playable", help="是否只查可扮演角色，true/false")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出")
    return parser


def print_human_readable(result: Dict[str, Any]) -> None:
    print(f"[QUERY] {result['query']}")
    print(f"[MODE] {result['mode']}")
    print(f"[FILTERS] {json.dumps(result['filters'], ensure_ascii=False)}")
    if not result["hits"]:
        print("[EMPTY] 未检索到结果")
        return

    for hit in result["hits"]:
        print(
            f"[{hit['rank']:02d}] {hit['source_id']} | {hit['record_type']} | {hit['character']} "
            f"| score={hit['score']:.6f}"
        )
        print(f"     tags={','.join(hit['all_tags'])}")
        print(f"     text={hit['text']}")


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()
    result = search_documents(
        query=args.query,
        mode=args.mode,
        size=args.size,
        character=args.character,
        record_types=parse_csv_arg(args.record_type),
        playable=parse_bool_flag(args.playable),
        character_types=parse_csv_arg(args.character_type),
        tags=parse_csv_arg(args.all_tags),
        chapter=args.chapter,
        candidate_size=args.candidate_size,
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_human_readable(result)


if __name__ == "__main__":
    main()
