import { vi } from "vitest";
import type { StreamEvent } from "../../src/common/types";

/**
 * 统一的外部依赖 mock 工厂，供新增测试复用。
 * 现有测试文件保持各自的 mock 实现，不强制迁移。
 */

/**
 * 创建一个带完整字段的 ES hit，用于验证标签映射和 RRF 融合。
 * 现有测试的 generateHits 缺少 tags.scene/emotion/function 结构化字段，
 * 本工厂补全这些字段以支持标签增强检索验证。
 */
export function createEsHit(overrides: Record<string, unknown> = {}) {
  return {
    _score: 1,
    _source: {
      source_id: "doc-1",
      record_type: "dialogue",
      character: "丛雨",
      text: "文档内容",
      text_norm: "文档内容",
      all_tags: ["greeting"],
      tags: {
        scene: ["神社"],
        emotion: ["开心"],
        function: ["问候"],
      },
      ...overrides,
    },
  };
}

/** 批量生成 ES hits，可指定 tags 结构化字段。 */
export function generateHitsWithTags(
  count: number,
  tags?: { scene?: string[]; emotion?: string[]; function?: string[] },
) {
  return Array.from({ length: count }, (_, i) =>
    createEsHit({
      _score: 1 - i * 0.01,
      _source: {
        source_id: `doc-${i}`,
        record_type: "dialogue",
        character: "丛雨",
        text: `文档内容 ${i}`,
        text_norm: `文档内容 ${i}`,
        all_tags: [`tag-${i}`],
        tags: tags ?? { scene: ["神社"], emotion: ["开心"], function: ["问候"] },
      },
    }),
  );
}

/**
 * 创建一个收集 SSE 事件的 mock publish 函数。
 * 返回 publish 函数和一个 events 数组供断言。
 */
export function createSsePublishCollector() {
  const events: StreamEvent[] = [];
  const publish = vi.fn((event: StreamEvent) => {
    events.push(event);
  });
  return { publish, events };
}
