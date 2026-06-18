import json
import os
import re
import time
import urllib.request
from urllib.error import HTTPError, URLError
import warnings
from pathlib import Path
from typing import Dict, Iterable, List

from elasticsearch import Elasticsearch, helpers
from tqdm import tqdm
from urllib3.exceptions import InsecureRequestWarning


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "索引数据"

# 允许通过环境变量覆盖，默认值直接使用你给的配置。
ES_URL = os.environ.get("ES_URL") or os.environ.get("ES_NODE") or "https://127.0.0.1:9200/"
ES_USERNAME = os.environ.get("ES_USERNAME") or os.environ.get("ES_USER") or "elastic"
ES_PASSWORD = os.environ.get("ES_PASSWORD") or ""
ES_INDEX_NAME = os.environ.get("ES_INDEX_NAME", "senren_dialogues")

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL_NAME = os.environ.get("OLLAMA_MODEL_NAME", "bge-m3:latest")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "64"))
TEXT_MAX_LENGTH = int(os.environ.get("TEXT_MAX_LENGTH", "512"))
SPARSE_TOP_N = int(os.environ.get("SPARSE_TOP_N", "20"))
OLLAMA_RETRY_COUNT = int(os.environ.get("OLLAMA_RETRY_COUNT", "3"))
OLLAMA_RETRY_DELAY = float(os.environ.get("OLLAMA_RETRY_DELAY", "1.5"))


def load_jsonl(file_path: Path) -> List[dict]:
    rows: List[dict] = []
    with file_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def load_json(file_path: Path) -> dict:
    with file_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def build_tag_map(rows: Iterable[dict]) -> Dict[str, dict]:
    return {row["source_id"]: row for row in rows}


def build_sparse_terms(text: str, top_n: int) -> List[str]:
    # Ollama 的 embedding 接口只返回 dense embedding，这里用轻量词项提取保留
    # 一个可过滤的 sparse_terms 字段，便于后续在 ES 中做 terms/filter。
    tokens = re.findall(r"[\u4e00-\u9fff]{1,4}|[A-Za-z0-9_]+", text)
    unique_tokens: List[str] = []
    seen = set()
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        unique_tokens.append(token)
        if len(unique_tokens) >= top_n:
            break
    return unique_tokens


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
    cleaned = re.sub(r'[「」『』“”]+', " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def build_dialogue_docs(dialogues: List[dict], dialogue_tags: Dict[str, dict]) -> List[dict]:
    docs: List[dict] = []
    for row in dialogues:
        tag_row = dialogue_tags.get(row["dialogue_id"], {})
        docs.append(
            {
                "_id": row["dialogue_id"],
                "source_id": row["dialogue_id"],
                "record_type": row["record_type"],
                "character": row["character"],
                "character_type": row["character_type"],
                "is_playable": row["is_playable"],
                "chapter": row.get("chapter", ""),
                "chapter_major": row.get("chapter_major"),
                "chapter_minor": row.get("chapter_minor"),
                "chapter_order": row.get("chapter_order"),
                "text": row["text"],
                "text_norm": row["text_norm"],
                "text_length": row["text_length"],
                "all_tags": tag_row.get("all_tags", []),
                "tags": tag_row.get("tags", {}),
                "source_dialogue_keys": [],
            }
        )
    return docs


def build_passage_docs(passages: List[dict], passage_tags: Dict[str, dict]) -> List[dict]:
    docs: List[dict] = []
    for row in passages:
        tag_row = passage_tags.get(row["passage_id"], {})
        context_before = row.get("context_before", [])
        context_after = row.get("context_after", [])
        docs.append(
            {
                "_id": row["passage_id"],
                "source_id": row["passage_id"],
                "record_type": row["record_type"],
                "character": row["character"],
                "character_type": row["character_type"],
                "is_playable": row["is_playable"],
                "chapter": row.get("chapter", ""),
                "chapter_major": row.get("chapter_major"),
                "chapter_minor": row.get("chapter_minor"),
                "chapter_order": row.get("chapter_order"),
                "text": row["passage"],
                "text_norm": row["passage_norm"],
                "text_length": row["char_count"],
                "all_tags": tag_row.get("all_tags", []),
                "tags": tag_row.get("tags", {}),
                "source_dialogue_keys": row.get("source_dialogue_keys", []),
                "context_before": " / ".join(f'{c["character"]}: {c["text"]}' for c in context_before) if context_before else "",
                "context_after": " / ".join(f'{c["character"]}: {c["text"]}' for c in context_after) if context_after else "",
            }
        )
    return docs


def batched(rows: List[dict], batch_size: int) -> Iterable[List[dict]]:
    for i in range(0, len(rows), batch_size):
        yield rows[i : i + batch_size]


def create_es_client() -> Elasticsearch:
    warnings.simplefilter("ignore", InsecureRequestWarning)
    return Elasticsearch(
        ES_URL,
        basic_auth=(ES_USERNAME, ES_PASSWORD),
        verify_certs=False,
        ssl_show_warn=False,
        request_timeout=120,
    )


def ensure_index(es: Elasticsearch, index_name: str, mapping: dict) -> None:
    if es.indices.exists(index=index_name):
        print(f"[ES] 删除旧索引: {index_name}")
        es.indices.delete(index=index_name)

    print(f"[ES] 创建索引: {index_name}")
    es.indices.create(index=index_name, body=mapping)


def get_ollama_embeddings(texts: List[str]) -> List[List[float]]:
    payload = json.dumps(
        {
            "model": OLLAMA_MODEL_NAME,
            "input": texts,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        f"{OLLAMA_HOST.rstrip('/')}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=300) as response:
        data = json.loads(response.read().decode("utf-8"))

    embeddings = data.get("embeddings")
    if not embeddings or len(embeddings) != len(texts):
        raise RuntimeError("Ollama embedding 返回结果异常，embeddings 数量与输入不一致。")
    return embeddings


def get_ollama_embeddings_resilient(texts: List[str]) -> List[List[float]]:
    for attempt in range(1, OLLAMA_RETRY_COUNT + 1):
        try:
            return get_ollama_embeddings(texts)
        except (HTTPError, URLError, RuntimeError) as exc:
            if attempt == OLLAMA_RETRY_COUNT:
                break
            time.sleep(OLLAMA_RETRY_DELAY * attempt)

    if len(texts) == 1:
        fallback_text = normalize_embedding_text(texts[0])
        if fallback_text and fallback_text != texts[0]:
            print(f"[OLLAMA] 单条 embedding 失败，清洗文本后重试: {texts[0][:80]!r}")
            for attempt in range(1, OLLAMA_RETRY_COUNT + 1):
                try:
                    return get_ollama_embeddings([fallback_text])
                except (HTTPError, URLError, RuntimeError):
                    if attempt == OLLAMA_RETRY_COUNT:
                        break
                    time.sleep(OLLAMA_RETRY_DELAY * attempt)
        raise RuntimeError(f"Ollama 对单条文本 embedding 失败，文本前 80 字: {texts[0][:80]!r}")

    mid = max(1, len(texts) // 2)
    left = get_ollama_embeddings_resilient(texts[:mid])
    right = get_ollama_embeddings_resilient(texts[mid:])
    return left + right


def encode_and_upload(es: Elasticsearch, docs: List[dict]) -> None:
    total = len(docs)
    progress = tqdm(total=total, desc="上传到 ES", unit="doc")
    skipped_docs = 0

    for batch in batched(docs, BATCH_SIZE):
        texts = [row["text"][:TEXT_MAX_LENGTH] for row in batch]
        actions = []
        embeddings = None
        try:
            embeddings = get_ollama_embeddings_resilient(texts)
        except RuntimeError:
            print("[OLLAMA] 当前批次存在异常文本，切换为逐条重试")

        for idx, row in enumerate(batch):
            raw_text = texts[idx]
            try:
                dense_vec = embeddings[idx] if embeddings is not None else get_ollama_embeddings_resilient([raw_text])[0]
            except RuntimeError:
                fallback_text = row.get("text_norm", "")[:TEXT_MAX_LENGTH].strip()
                if fallback_text and fallback_text != raw_text:
                    print(f"[OLLAMA] 改用 text_norm 重试: {row['_id']}")
                    try:
                        dense_vec = get_ollama_embeddings_resilient([fallback_text])[0]
                    except RuntimeError:
                        print(f"[SKIP] embedding 失败，跳过文档: {row['_id']}")
                        skipped_docs += 1
                        progress.update(1)
                        continue
                else:
                    print(f"[SKIP] embedding 失败，跳过文档: {row['_id']}")
                    skipped_docs += 1
                    progress.update(1)
                    continue
            actions.append(
                {
                    "_index": ES_INDEX_NAME,
                    "_id": row["_id"],
                    "_source": {
                        "source_id": row["source_id"],
                        "record_type": row["record_type"],
                        "character": row["character"],
                        "character_type": row["character_type"],
                        "is_playable": row["is_playable"],
                        "chapter": row["chapter"],
                        "chapter_major": row["chapter_major"],
                        "chapter_minor": row["chapter_minor"],
                        "chapter_order": row["chapter_order"],
                        "text": row["text"],
                        "text_norm": row["text_norm"],
                        "text_length": row["text_length"],
                        "all_tags": row["all_tags"],
                        "tags": row["tags"],
                        "source_dialogue_keys": row["source_dialogue_keys"],
                        "context_before": row.get("context_before", ""),
                        "context_after": row.get("context_after", ""),
                        "sparse_terms": build_sparse_terms(row["text_norm"], SPARSE_TOP_N),
                        "dense_vector": dense_vec,
                    },
                }
            )

        if actions:
            es_bulk = es.options(request_timeout=120)
            helpers.bulk(es_bulk, actions)
        progress.update(len(actions))

    progress.close()
    if skipped_docs:
        print(f"[WARN] 共跳过 {skipped_docs} 条无法生成 embedding 的文档")


def main() -> None:
    mapping = load_json(DATA_DIR / "es_index_config.json")
    dialogues = load_jsonl(DATA_DIR / "dialogues_clean.jsonl")
    passages = load_jsonl(DATA_DIR / "dialogue_passages.jsonl")
    dialogue_tags = build_tag_map(load_jsonl(DATA_DIR / "dialogue_tags.jsonl"))
    passage_tags = build_tag_map(load_jsonl(DATA_DIR / "passage_tags.jsonl"))

    docs = build_dialogue_docs(dialogues, dialogue_tags) + build_passage_docs(passages, passage_tags)
    print(f"[DATA] 单句: {len(dialogues)}")
    print(f"[DATA] 段落: {len(passages)}")
    print(f"[DATA] 总待上传: {len(docs)}")

    es = create_es_client()
    info = es.info()
    print(f"[ES] 已连接: {info.get('cluster_name', 'unknown')}")

    ensure_index(es, ES_INDEX_NAME, mapping)

    print(f"[OLLAMA] 使用本地模型: {OLLAMA_MODEL_NAME}")
    print(f"[OLLAMA] 服务地址: {OLLAMA_HOST}")

    encode_and_upload(es, docs)
    es.indices.refresh(index=ES_INDEX_NAME)
    count = es.count(index=ES_INDEX_NAME)["count"]
    print(f"[DONE] 索引 {ES_INDEX_NAME} 共写入 {count} 条文档")


if __name__ == "__main__":
    main()
