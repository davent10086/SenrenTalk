import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { Client, estypes } from "@elastic/elasticsearch";
import type { AppConfig } from "../../config";
import type { MemoryEvent, RetrievedDoc, RetrievalFilters, TagCollection, CoreMemory } from "../../../common/types";
import { BgeM3EmbeddingService } from "./bge-m3-embedding-service";

/**
 * 高频标签黑名单：这些标签在数据集中出现频率超过60%，缺乏区分度，
 * 在 Tag Match 检索中会产生大量噪声匹配，需要过滤掉。
 */
const HIGH_FREQUENCY_TAGS = new Set([
  "日常对话",
  "日常寒暄",
  "平静",
]);

interface DatasetRow extends Record<string, unknown> {
  dialogue_id?: string;
  passage_id?: string;
  record_type?: "dialogue" | "passage";
  character?: string;
  character_type?: string;
  is_playable?: boolean;
  chapter?: string;
  text?: string;
  text_norm?: string;
  passage?: string;
  passage_norm?: string;
  char_count?: number;
  source_dialogue_keys?: string[];
}

interface TagRow extends Record<string, unknown> {
  source_id: string;
  all_tags?: string[];
  tags?: TagCollection;
}

function rrfFuse(resultSets: RetrievedDoc[][], limit: number): RetrievedDoc[] {
  const scores = new Map<string, number>();
  const docs = new Map<string, RetrievedDoc>();

  resultSets.forEach((results) => {
    results.forEach((doc, rank) => {
      docs.set(doc.sourceId, doc);
      scores.set(doc.sourceId, (scores.get(doc.sourceId) ?? 0) + 1 / (60 + rank + 1));
    });
  });

  return Array.from(scores.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([sourceId]) => docs.get(sourceId))
    .filter((doc): doc is RetrievedDoc => Boolean(doc));
}

function buildFilters(filters: RetrievalFilters, isMemory = false): Array<Record<string, unknown>> {
  const clauses: Array<Record<string, unknown>> = [];
  if (filters.character) {
    clauses.push({ term: { character: filters.character } });
  }
  if (!isMemory && filters.recordType) {
    clauses.push({ term: { record_type: filters.recordType } });
  }
  if (!isMemory && filters.chapter) {
    clauses.push({ term: { chapter: filters.chapter } });
  }
  if (!isMemory && typeof filters.isPlayable === "boolean") {
    clauses.push({ term: { is_playable: filters.isPlayable } });
  }
  if (isMemory && filters.sessionId) {
    clauses.push({ term: { session_id: filters.sessionId } });
  }
  if (isMemory && filters.category) {
    clauses.push({ term: { category: filters.category } });
  }
  return clauses;
}

function mapHits(hits: Array<{ _score?: number | null; _source?: Record<string, unknown> }>, isMemory = false): RetrievedDoc[] {
  return hits
    .map((hit) => {
      const source = hit._source ?? {};
      return {
        sourceId: String(source.source_id ?? source.id ?? ""),
        recordType: isMemory ? "memory" : (String(source.record_type ?? "dialogue") as "dialogue" | "passage"),
        character: String(source.character ?? ""),
        text: String(source.content ?? source.text ?? ""),
        score: typeof hit._score === "number" ? hit._score : 0,
        chapter: source.chapter ? String(source.chapter) : undefined,
        isPlayable: typeof source.is_playable === "boolean" ? source.is_playable : undefined,
        tags: (source.tags ?? {}) as TagCollection,
        sourceDialogueKeys: Array.isArray(source.source_dialogue_keys)
          ? source.source_dialogue_keys.map((value) => String(value))
          : undefined,
        contextBefore: source.context_before ? String(source.context_before) : undefined,
        contextAfter: source.context_after ? String(source.context_after) : undefined,
      } satisfies RetrievedDoc;
    })
    .filter((doc) => Boolean(doc.sourceId));
}

/**
 * Elasticsearch 服务，负责对话索引管理、混合检索（稠密向量 + BM25 + 标签）、
 * 记忆管理以及核心记忆索引。
 */
export class ElasticsearchService {
  private readonly client?: Client;
  private readonly embeddingService: BgeM3EmbeddingService;
  private dialogueIndexEnsured = false;
  private memoryIndexEnsured = false;

  /**
   * @param config 应用程序配置对象
   */
  constructor(private readonly config: AppConfig) {
    this.embeddingService = new BgeM3EmbeddingService(config);
    if (config.esPassword) {
      this.client = new Client({
        node: config.esNode,
        auth: {
          username: config.esUsername,
          password: config.esPassword,
        },
        tls: {
          rejectUnauthorized: config.esRejectUnauthorized,
        },
      });
    }
  }

  /**
   * 检查 Elasticsearch 客户端是否可用。
   * @returns 如果已配置 ES 密码则返回 true
   */
  get enabled(): boolean {
    return Boolean(this.client);
  }

  /**
   * 测试 Elasticsearch 连接是否正常。
   * @returns 连接成功返回 true，否则返回 false
   */
  async ping(): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 确保对话索引存在，不存在则基于数据集中的映射配置创建。
   */
  async ensureDialogueIndex(): Promise<void> {
    if (!this.client || this.dialogueIndexEnsured) {
      return;
    }
    const mappingPath = path.join(this.config.datasetDir, "es_index_config.json");
    const mappingRaw = await fs.readFile(mappingPath, "utf-8");
    const mapping = JSON.parse(mappingRaw) as Record<string, unknown>;
    const mappings = (mapping.mappings ?? {}) as Record<string, unknown>;
    const properties = (mappings.properties ?? {}) as Record<string, unknown>;
    properties.dense_vector = {
      type: "dense_vector",
      dims: this.config.embeddingDimensions,
      index: true,
      similarity: "cosine",
      index_options: {
        type: "hnsw",
        m: 16,
        ef_construction: 100,
      },
    };
    const exists = await this.client.indices.exists({ index: this.config.esDialogueIndex });
    if (!exists) {
      await this.client.indices.create({
        index: this.config.esDialogueIndex,
        body: {
          ...mapping,
          mappings: {
            ...mappings,
            properties,
          },
        } as never,
      });
    }
    this.dialogueIndexEnsured = true;
  }

  /**
   * 确保记忆索引存在，不存在则创建。
   */
  async ensureMemoryIndex(): Promise<void> {
    if (!this.client || this.memoryIndexEnsured) {
      return;
    }
    const exists = await this.client.indices.exists({ index: this.config.esMemoryIndex });
    if (!exists) {
      await this.client.indices.create({
        index: this.config.esMemoryIndex,
        body: {
          mappings: {
            properties: {
              source_id: { type: "keyword" },
              record_type: { type: "keyword" },
              session_id: { type: "keyword" },
              character: { type: "keyword" },
              content: { type: "text" },
              category: { type: "keyword" },
              timestamp: { type: "date" },
              tags: { type: "keyword" },
              dense_vector: {
                type: "dense_vector",
                dims: this.config.embeddingDimensions,
                index: true,
                similarity: "cosine",
              },
            },
          },
        } as never,
      });
    }
    this.memoryIndexEnsured = true;
  }

  /**
   * 构建对话索引：流式读取数据、分批生成向量并批量写入 ES，避免大数据集 OOM。
   * @returns 已索引的记录数量
   */
  async buildDialogueIndex(): Promise<{ indexedCount: number }> {
    if (!this.client) {
      return { indexedCount: 0 };
    }

    await this.ensureDialogueIndex();

    const readJsonLines = async <T>(filePath: string): Promise<T[]> => {
      const raw = await fs.readFile(filePath, "utf-8");
      return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
    };

    const dialogueTags = await readJsonLines<TagRow>(path.join(this.config.datasetDir, "dialogue_tags.jsonl"));
    const passageTags = await readJsonLines<TagRow>(path.join(this.config.datasetDir, "passage_tags.jsonl"));
    const tagsById = new Map<string, TagRow>();
    [...dialogueTags, ...passageTags].forEach((row) => tagsById.set(row.source_id, row));

    const BATCH_SIZE = 500;
    let indexedCount = 0;

    for (const file of ["dialogues_clean.jsonl", "dialogue_passages.jsonl"]) {
      const filePath = path.join(this.config.datasetDir, file);
      const lines = await this.readJsonLinesStream<DatasetRow>(filePath);
      const batches = this.chunkArray(lines, BATCH_SIZE);

      for (const batch of batches) {
        const texts = batch.map((row) =>
          String(row.text_norm ?? row.passage_norm ?? row.text ?? row.passage ?? ""),
        );
        const embeddings = await this.embeddingService.embedMany(texts);

        const records = batch.map((row, index) => {
          const sourceId = String(row.dialogue_id ?? row.passage_id ?? "");
          const text = String(row.text ?? row.passage ?? "");
          const normalizedText = String(row.text_norm ?? row.passage_norm ?? text);
          const tagRow = tagsById.get(sourceId);
          const contextBefore = Array.isArray(row.context_before)
            ? row.context_before.map((c: { character: string; text: string }) => `${c.character}: ${c.text}`).join(" / ")
            : "";
          const contextAfter = Array.isArray(row.context_after)
            ? row.context_after.map((c: { character: string; text: string }) => `${c.character}: ${c.text}`).join(" / ")
            : "";
          return {
            source_id: sourceId,
            record_type: String(row.record_type ?? (row.passage_id ? "passage" : "dialogue")),
            character: String(row.character ?? "未知角色"),
            character_type: String(row.character_type ?? "support"),
            is_playable: Boolean(row.is_playable),
            chapter: row.chapter ? String(row.chapter) : undefined,
            text,
            text_norm: normalizedText,
            text_length: typeof row.char_count === "number" ? row.char_count : text.length,
            all_tags: tagRow?.all_tags ?? [],
            tags: tagRow?.tags ?? {},
            source_dialogue_keys: Array.isArray(row.source_dialogue_keys)
              ? row.source_dialogue_keys.map((value) => String(value))
              : [],
            context_before: contextBefore,
            context_after: contextAfter,
            dense_vector: embeddings[index] ?? [],
          };
        });

        const operations = records.flatMap((record) => [
          { index: { _index: this.config.esDialogueIndex, _id: record.source_id } },
          record,
        ]);
        await this.client!.bulk({ refresh: true, operations });
        indexedCount += records.length;
      }
    }

    return { indexedCount };
  }

  /** 流式读取 JSONL 文件，逐行解析为对象数组。 */
  private async readJsonLinesStream<T>(filePath: string): Promise<T[]> {
    const results: T[] = [];
    const stream = createReadStream(filePath, "utf-8");
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        results.push(JSON.parse(line) as T);
      }
    }
    return results;
  }

  /** 将数组切分为固定大小的批次。 */
  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * 混合检索：结合稠密向量（knn）、BM25 文本匹配和标签匹配，三路单次 RRF 融合后经语义重排序。
   * @param query 搜索查询文本
   * @param filters 检索过滤条件
   * @returns 融合排序后的检索结果
   */
  async hybridSearch(query: string, filters: RetrievalFilters = {}): Promise<RetrievedDoc[]> {
    if (!this.client) return [];
    await this.ensureDialogueIndex();
    const topK = filters.topK ?? this.config.topK;
    const candidateSize = topK * 3;
    const commonFilters = buildFilters(filters, false);
    // 过滤高频标签，避免噪声匹配
    const tagTerms = [
      ...(filters.tags?.scene ?? []),
      ...(filters.tags?.emotion ?? []),
      ...(filters.tags?.function ?? []),
      ...(filters.tags?.tone ?? []),
    ].filter((tag) => !HIGH_FREQUENCY_TAGS.has(tag));

    // 提前计算 query embedding，供 dense 检索和 rerank 复用
    const queryVector = await this.tryEmbed(query, "dialogue-search");

    // 三路并行检索
    const [denseResults, bm25Results, tagResults] = await Promise.all([
      this.runDenseQuery(this.config.esDialogueIndex, queryVector, candidateSize, commonFilters, false),
      this.runBm25Query(this.config.esDialogueIndex, query, candidateSize, ["text^2", "text_norm", "all_tags"], commonFilters, false),
      tagTerms.length > 0
        ? this.runTagQuery(this.config.esDialogueIndex, tagTerms, candidateSize, commonFilters)
        : Promise.resolve([]),
    ]);

    // 三路单次 RRF 融合
    const fused = rrfFuse([denseResults, bm25Results, tagResults], candidateSize);
    return this.rerankByEmbedding(query, fused, topK, queryVector);
  }

  /**
   * 索引一条记忆事件。
   * @param event 记忆事件对象
   */
  async indexMemory(event: MemoryEvent): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.ensureMemoryIndex();
    const denseVector = await this.tryEmbed(event.content, "memory-index");
    await this.client.index({
      index: this.config.esMemoryIndex,
      id: event.id,
      refresh: true,
      document: {
        source_id: event.id,
        record_type: "memory",
        session_id: event.sessionId,
        character: event.character,
        content: event.content,
        category: event.category,
        timestamp: event.timestamp,
        tags: event.tags,
        ...(denseVector ? { dense_vector: denseVector } : {}),
      },
    });
  }

  /**
   * 按会话 ID 删除该会话下的所有记忆。
   * @param sessionId 会话 ID
   */
  async deleteMemoriesBySession(sessionId: string): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.ensureMemoryIndex();
    await this.client.deleteByQuery({
      index: this.config.esMemoryIndex,
      refresh: true,
      query: {
        term: {
          session_id: sessionId,
        },
      },
    });
  }

  /**
   * 记忆搜索：结合稠密向量（knn）和 BM25 进行混合检索，RRF 融合后经语义重排序。
   */
  async searchMemories(query: string, filters: RetrievalFilters = {}): Promise<RetrievedDoc[]> {
    if (!this.client) return [];
    await this.ensureMemoryIndex();
    const topK = filters.topK ?? this.config.topK;
    const filterClauses = buildFilters(filters, true);

    // 提前计算 query embedding，供 dense 检索和 rerank 复用
    const queryVector = await this.tryEmbed(query, "memory-search");

    const fused = await this.runHybridQuery(
      query, this.config.esMemoryIndex, filterClauses,
      ["content^2", "tags", "category"], true, topK, queryVector,
    );
    return this.rerankByEmbedding(query, fused, topK, queryVector);
  }

  /**
   * 通用混合查询：执行 dense (kNN) + BM25 双路检索并 RRF 融合。
   * 复用 {@link runDenseQuery} 和 {@link runBm25Query}，与 {@link hybridSearch} 共享单路查询逻辑。
   */

  private async runHybridQuery(
    query: string,
    index: string,
    filterClauses: Array<Record<string, unknown>>,
    bm25Fields: string[],
    isMemory: boolean,
    topK: number,
    precomputedQueryVector?: number[] | null,
  ): Promise<RetrievedDoc[]> {
    const queryVector = precomputedQueryVector ?? await this.tryEmbed(query, isMemory ? "memory-search" : "dialogue-search");

    const [denseResults, bm25Results] = await Promise.all([
      this.runDenseQuery(index, queryVector, topK, filterClauses, isMemory),
      this.runBm25Query(index, query, topK, bm25Fields, filterClauses, isMemory),
    ]);

    return rrfFuse([denseResults, bm25Results], topK * 2);
  }

  /**
   * 执行单路稠密向量（kNN）检索。queryVector 为 null 时返回空数组。
   */
  private async runDenseQuery(
    index: string,
    queryVector: number[] | null,
    size: number,
    filterClauses: Array<Record<string, unknown>>,
    isMemory: boolean,
  ): Promise<RetrievedDoc[]> {
    if (!queryVector) {
      return [];
    }
    const results = await this.client!.search<Record<string, unknown>>({
      index,
      size,
      knn: {
        field: "dense_vector" as const,
        query_vector: queryVector,
        k: size,
        num_candidates: size * 10,
        ...(filterClauses.length > 0 ? { filter: { bool: { filter: filterClauses } } } : {}),
      } satisfies estypes.KnnQuery,
    });
    return mapHits(results.hits.hits, isMemory);
  }

  /**
   * 执行单路 BM25 文本匹配检索。
   */
  private async runBm25Query(
    index: string,
    query: string,
    size: number,
    bm25Fields: string[],
    filterClauses: Array<Record<string, unknown>>,
    isMemory: boolean,
  ): Promise<RetrievedDoc[]> {
    const results = await this.client!.search<Record<string, unknown>>({
      index,
      size,
      query: { bool: { filter: filterClauses, must: [{ multi_match: { query, fields: bm25Fields } }] } },
    });
    return mapHits(results.hits.hits, isMemory);
  }

  /**
   * 执行单路标签匹配检索（仅用于对话索引的 tag-aware 召回）。
   */
  private async runTagQuery(
    index: string,
    tagTerms: string[],
    size: number,
    filterClauses: Array<Record<string, unknown>>,
  ): Promise<RetrievedDoc[]> {
    const results = await this.client!.search<Record<string, unknown>>({
      index,
      size,
      query: {
        bool: {
          filter: filterClauses,
          should: tagTerms.map((t) => ({ term: { all_tags: t } })),
          minimum_should_match: Math.min(2, tagTerms.length),
        },
      },
    });
    return mapHits(results.hits.hits);
  }

  /**
   * 对 RRF 融合后的候选结果进行语义重排序。
   * 使用 BGE-M3 对候选文本重新计算与 query 的余弦相似度，按新分数排序截断。
   * 若 embedding 不可用则回退到 RRF 原始顺序。
   */
  private async rerankByEmbedding(
    query: string,
    candidates: RetrievedDoc[],
    topK: number,
    precomputedQueryVector?: number[] | null,
  ): Promise<RetrievedDoc[]> {
    if (candidates.length <= topK) return candidates;

    const queryVector = precomputedQueryVector ?? await this.tryEmbed(query, "rerank");
    if (!queryVector) return candidates.slice(0, topK);

    try {
      const texts = candidates.map((doc) => doc.text);
      const embeddings = await this.embeddingService.embedMany(texts);

      const scored = candidates.map((doc, i) => {
        const emb = embeddings[i];
        if (!emb || emb.length === 0) return { ...doc, score: 0 };
        const dot = emb.reduce((sum, v, j) => sum + v * (queryVector[j] ?? 0), 0);
        const normA = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
        const normB = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0));
        const cosine = normA > 0 && normB > 0 ? dot / (normA * normB) : 0;
        return { ...doc, score: cosine };
      });

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    } catch (error) {
      console.warn(
        `[ElasticsearchService] rerank embedding failed, fallback to RRF order:`,
        error instanceof Error ? error.message : error,
      );
      return candidates.slice(0, topK);
    }
  }

  private async tryEmbed(text: string, context: string): Promise<number[] | null> {
    try {
      return await this.embeddingService.embed(text);
    } catch (error) {
      console.warn(
        `[ElasticsearchService] embedding unavailable in ${context}, fallback to non-dense retrieval:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
  // ============ Core Memory Index ============

  /**
   * 确保核心记忆索引存在。
   */
  async ensureCoreMemoryIndex(): Promise<void> {
    if (!this.client) { return; }
    await this.ensureMemoryIndex();
  }

  /**
   * 索引一条核心记忆。
   * @param core 核心记忆对象
   */
  async indexCoreMemory(core: CoreMemory): Promise<void> {
    if (!this.client) { return; }
    await this.ensureCoreMemoryIndex();
    // 构建语义化文本用于 embedding，包含关系阶段、用户画像和关键事实，
    // 比 JSON.stringify(keyFacts) 能更准确地捕捉核心记忆语义，提升检索召回率
    const embeddingText = [
      core.relationshipStage ? `关系阶段：${core.relationshipStage}` : "",
      core.userPreferences.length > 0 ? `用户偏好：${core.userPreferences.join("、")}` : "",
      core.userTraits.length > 0 ? `用户特质：${core.userTraits.join("、")}` : "",
      core.relationshipNotes.length > 0 ? `关系备注：${core.relationshipNotes.join("、")}` : "",
      core.keyFacts.length > 0 ? `关键事实：${core.keyFacts.join("、")}` : "",
    ].filter(Boolean).join("\n");
    const denseVector = await this.tryEmbed(
      embeddingText || core.relationshipStage || core.character,
      "core-memory-index",
    );
    await this.client.index({
      index: this.config.esMemoryIndex,
      id: "core_" + core.id,
      refresh: true,
      document: {
        source_id: core.id,
        record_type: "core_memory",
        session_id: core.chatId,
        character: core.character,
        content: JSON.stringify({ preferences: core.userPreferences, traits: core.userTraits, stage: core.relationshipStage, notes: core.relationshipNotes, facts: core.keyFacts }),
        summary: core.relationshipStage,
        emotion: "",
        importance: 10,
        key_points: core.keyFacts,
        category: "core_memory",
        timestamp: core.lastUpdated,
        tags: [core.character, "core_memory"],
        ...(denseVector ? { dense_vector: denseVector } : {}),
      },
    });
  }
}
