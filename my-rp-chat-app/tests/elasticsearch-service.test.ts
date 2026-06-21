import { describe, expect, it, vi, beforeEach } from "vitest";

// mock fs/promises.readFile 避免 ensureDialogueIndex 读取真实文件
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(JSON.stringify({
      mappings: { properties: { text: { type: "text" } } },
    })),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
  readFile: vi.fn().mockResolvedValue(JSON.stringify({
    mappings: { properties: { text: { type: "text" } } },
  })),
}));

// 共享的 mock 函数
const mockSearch = vi.fn();
const mockIndex = vi.fn();
const mockPing = vi.fn().mockResolvedValue(true);
const mockIndicesExists = vi.fn().mockResolvedValue(true);
const mockIndicesCreate = vi.fn().mockResolvedValue(undefined);
const mockEmbed = vi.fn<(text: string) => Promise<number[]>>().mockResolvedValue([0.1, 0.2, 0.3]);
const mockEmbedMany = vi.fn<(texts: string[]) => Promise<number[][]>>().mockResolvedValue([[0.1, 0.2, 0.3]]);

vi.mock("../src/backend/services/es/bge-m3-embedding-service", () => ({
  BgeM3EmbeddingService: class MockBgeM3EmbeddingService {
    embed = mockEmbed;
    embedMany = mockEmbedMany;
  },
}));

vi.mock("@elastic/elasticsearch", () => ({
  Client: class MockClient {
    search = mockSearch;
    index = mockIndex;
    ping = mockPing;
    indices = { exists: mockIndicesExists, create: mockIndicesCreate };
  },
  estypes: {} as never,
}));

function createTestConfig() {
  return {
    esNode: "http://localhost:9200",
    esEnabled: true,
    esDialogueIndex: "test-dialogue",
    esMemoryIndex: "test-memory",
    topK: 10,
    esPassword: "test-password",
    esUsername: "test-user",
    esRejectUnauthorized: false,
    datasetDir: "/tmp/test-dataset",
    embeddingDimensions: 1024,
  } as never;
}

function generateHits(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    _score: 1 - i * 0.01,
    _source: {
      source_id: `doc-${i}`,
      record_type: "dialogue",
      character: "丛雨",
      text: `文档内容 ${i}`,
      text_norm: `文档内容 ${i}`,
      all_tags: ["tag1"],
    },
  }));
}

describe("ElasticsearchService.hybridSearch (embedding dedup fix)", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEmbedMany.mockReset();
    mockEmbedMany.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  it("embeds query only once and reuses vector for dense search and rerank", async () => {
    // 修复前：hybridSearch 调用 tryEmbed(query) 一次用于 dense 检索，
    // rerankByEmbedding 又调用 tryEmbed(query) 一次，同一 query 被 embed 两次。
    // 修复后：queryVector 提前计算并传入 rerankByEmbedding 复用。
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    // dense/bm25/tag 各返回 30 条，RRF 融合后 > topK(10) 触发 rerank
    mockSearch
      .mockResolvedValueOnce({ hits: { hits: generateHits(30) } })
      .mockResolvedValueOnce({ hits: { hits: generateHits(30) } })
      .mockResolvedValueOnce({ hits: { hits: generateHits(30) } });

    await service.hybridSearch("测试查询", { topK: 10 });

    // 关键断言：embed 只被调用 1 次（修复前是 2 次）
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith("测试查询");
  });

  it("tag search uses candidateSize (topK*3) instead of topK", async () => {
    // 修复前：tag 检索 size: topK，dense/bm25 size: candidateSize (topK*3)
    // 修复后：tag 检索也使用 candidateSize，三路候选集大小一致
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    const emptyHits = { hits: { hits: [] } };
    mockSearch
      .mockResolvedValueOnce(emptyHits)
      .mockResolvedValueOnce(emptyHits)
      .mockResolvedValueOnce(emptyHits);

    await service.hybridSearch("测试", {
      topK: 10,
      tags: { scene: ["神社"], emotion: ["开心"] },
    });

    // 3 次 search 调用：dense, bm25, tag
    expect(mockSearch).toHaveBeenCalledTimes(3);
    const calls = mockSearch.mock.calls;

    // dense (calls[0]) size 应为 candidateSize = 30
    expect(calls[0][0].size).toBe(30);
    // bm25 (calls[1]) size 应为 candidateSize = 30
    expect(calls[1][0].size).toBe(30);
    // tag (calls[2]) size 应为 candidateSize = 30（修复前是 topK = 10）
    expect(calls[2][0].size).toBe(30);
  });

  it("filters out high-frequency tags from tag search", async () => {
    // 高频标签（日常对话、日常寒暄、平静）应被过滤，不参与 tag 检索
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    const emptyHits = { hits: { hits: [] } };
    mockSearch.mockResolvedValue(emptyHits);

    // 混合高频和非高频标签
    await service.hybridSearch("测试", {
      topK: 10,
      tags: {
        scene: ["日常对话", "神社"], // 日常对话 是高频标签
        emotion: ["平静", "开心"],   // 平静 是高频标签
      },
    });

    // 由于有非高频标签（神社、开心），tag 检索会执行，共 3 次 search
    expect(mockSearch).toHaveBeenCalledTimes(3);
    const calls = mockSearch.mock.calls;
    // 找到 tag 检索的调用（包含 should 的那个）
    const tagCall = calls.map((c) => c[0]).find((arg: Record<string, unknown>) => {
      const query = arg.query as Record<string, unknown> | undefined;
      const bool = query?.bool as Record<string, unknown> | undefined;
      return Array.isArray(bool?.should);
    });
    expect(tagCall).toBeDefined();
    const shouldTerms = (tagCall as Record<string, unknown>).query.bool.should as Array<{ term: { all_tags: string } }>;
    const tagValues = shouldTerms.map((s) => s.term.all_tags);

    // 高频标签应被过滤
    expect(tagValues).not.toContain("日常对话");
    expect(tagValues).not.toContain("平静");
    // 非高频标签应保留
    expect(tagValues).toContain("神社");
    expect(tagValues).toContain("开心");
  });
});

describe("ElasticsearchService.searchMemories (embedding dedup fix)", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEmbedMany.mockReset();
    mockEmbedMany.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  it("embeds query only once for memory search and rerank", async () => {
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    // runHybridQuery 内部调用 2 次 search（dense + bm25）
    // 返回足够多结果触发 rerank（topK=4，需 > 4 条）
    mockSearch
      .mockResolvedValueOnce({ hits: { hits: generateHits(20) } })
      .mockResolvedValueOnce({ hits: { hits: generateHits(20) } });

    await service.searchMemories("测试", { topK: 4 });

    // embed 只被调用 1 次（修复前是 2 次：search + rerank 各一次）
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });
});

describe("ElasticsearchService.hybridSearch (tag boost and degradation)", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEmbedMany.mockReset();
    mockEmbedMany.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  it("tag search includes scene, emotion, and function tags", async () => {
    // 验证：scene/emotion/function 三类标签都参与 tag 检索的 should 子句
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    const emptyHits = { hits: { hits: [] } };
    mockSearch.mockResolvedValue(emptyHits);

    await service.hybridSearch("测试", {
      topK: 10,
      tags: { scene: ["神社"], emotion: ["开心"], function: ["问候"] },
    });

    expect(mockSearch).toHaveBeenCalledTimes(3);
    const calls = mockSearch.mock.calls;
    // 找到 tag 检索的调用（包含 should 的那个）
    const tagCall = calls.map((c) => c[0]).find((arg: Record<string, unknown>) => {
      const query = arg.query as Record<string, unknown> | undefined;
      const bool = query?.bool as Record<string, unknown> | undefined;
      return Array.isArray(bool?.should);
    });
    expect(tagCall).toBeDefined();
    const shouldTerms = (tagCall as Record<string, unknown>).query.bool.should as Array<{ term: { all_tags: string } }>;
    const tagValues = shouldTerms.map((s) => s.term.all_tags);

    // 所有类型的标签都应参与 tag 检索
    expect(tagValues).toContain("神社");
    expect(tagValues).toContain("开心");
    expect(tagValues).toContain("问候");
  });

  it("tag boost contributes to RRF fusion results", async () => {
    // 验证：当 dense 和 bm25 返回空时，tag 检索的结果仍能通过 RRF 融合出现在最终结果中
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    const tagHits = [
      {
        _score: 1,
        _source: {
          source_id: "tag-doc-1",
          record_type: "dialogue",
          character: "丛雨",
          text: "神社的对话",
          text_norm: "神社的对话",
          all_tags: ["神社"],
          tags: { scene: ["神社"], emotion: ["开心"], function: ["问候"] },
        },
      },
    ];

    // dense 和 bm25 返回空，只有 tag 返回结果
    mockSearch
      .mockResolvedValueOnce({ hits: { hits: [] } })
      .mockResolvedValueOnce({ hits: { hits: [] } })
      .mockResolvedValueOnce({ hits: { hits: tagHits } });

    const results = await service.hybridSearch("神社", {
      topK: 10,
      tags: { scene: ["神社"] },
    });

    // tag 检索的结果应出现在最终结果中
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sourceId).toBe("tag-doc-1");
    expect(results[0].text).toBe("神社的对话");
  });

  it("falls back to bm25 when embedding fails", async () => {
    // 验证：embedding 服务不可用时，dense 检索被跳过，bm25 仍正常工作
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    // embed 抛出异常，模拟 embedding 服务不可用
    mockEmbed.mockRejectedValue(new Error("embedding service unavailable"));

    const bm25Hits = generateHits(3);
    mockSearch.mockResolvedValueOnce({ hits: { hits: bm25Hits } });

    const results = await service.hybridSearch("测试", { topK: 10 });

    // embed 被调用但失败
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    // 只有 bm25 检索（dense 被跳过，无 tags 所以无 tag 检索）
    expect(mockSearch).toHaveBeenCalledTimes(1);
    // 结果来自 bm25
    expect(results.length).toBe(3);
    expect(results[0].sourceId).toBe("doc-0");
  });

  it("skips tag search when all tags are high-frequency", async () => {
    // 验证：当所有标签都是高频标签时，tag 检索被完全跳过
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    const emptyHits = { hits: { hits: [] } };
    mockSearch.mockResolvedValue(emptyHits);

    // 所有标签都是高频标签（日常对话、平静）
    await service.hybridSearch("测试", {
      topK: 10,
      tags: { scene: ["日常对话"], emotion: ["平静"] },
    });

    // 只有 dense 和 bm25 检索，无 tag 检索
    expect(mockSearch).toHaveBeenCalledTimes(2);
    const calls = mockSearch.mock.calls;
    // 验证没有包含 should 的调用（即没有 tag 检索）
    const tagCall = calls.map((c) => c[0]).find((arg: Record<string, unknown>) => {
      const query = arg.query as Record<string, unknown> | undefined;
      const bool = query?.bool as Record<string, unknown> | undefined;
      return Array.isArray(bool?.should);
    });
    expect(tagCall).toBeUndefined();
  });

  it("mapHits preserves structured tags from ES source", async () => {
    // 验证：mapHits 正确映射 ES 的 tags 字段到 RetrievedDoc.tags
    const { ElasticsearchService } = await import("../src/backend/services/es/elasticsearch-service");
    const service = new ElasticsearchService(createTestConfig());

    const hitsWithTags = [
      {
        _score: 1,
        _source: {
          source_id: "doc-tags-1",
          record_type: "dialogue",
          character: "丛雨",
          text: "带标签的文档",
          text_norm: "带标签的文档",
          all_tags: ["神社", "开心"],
          tags: {
            scene: ["神社", "鸟居"],
            emotion: ["开心", "期待"],
            function: ["问候"],
          },
        },
      },
    ];

    // dense 返回带标签的 hit，bm25 和 tag 返回空
    mockSearch
      .mockResolvedValueOnce({ hits: { hits: hitsWithTags } })
      .mockResolvedValueOnce({ hits: { hits: [] } })
      .mockResolvedValueOnce({ hits: { hits: [] } });

    const results = await service.hybridSearch("测试", { topK: 10 });

    expect(results.length).toBeGreaterThan(0);
    const doc = results[0];
    expect(doc.tags).toBeDefined();
    expect(doc.tags?.scene).toEqual(["神社", "鸟居"]);
    expect(doc.tags?.emotion).toEqual(["开心", "期待"]);
    expect(doc.tags?.function).toEqual(["问候"]);
  });
});
