# Agent 调用链路（单聊）

> 本文档详细描述单聊场景下 LangGraph 的 `StateGraph` 执行流程。
> 若只需了解整体架构，请返回 [README](../README.md#架构总览)。

## 节点序列

```
START
  │   ▸ [1] prepare_turn
  │  确定当前发言角色 → 从数据库加载 CharacterProfile
  │  重置输出缓冲区 (output, speechTextJa, validationIssue)
  │  SSE 推送 status "正在准备角色数据..."
  │   ▸ [2] retrieve_context
  │  构建检索查询 buildRetrievalQuery()
  │  → 群聊模式: 拼接最近 6 条群聊消息作为查询上下文
  │  → ElasticsearchService.hybridSearch() (topK=6, 按 character 过滤)
  │  三路混合检索: dense_vector + BM25 + tag matching
  │  RRF 融合排序
  │   ▸ [3] retrieve_memory
  │  L1: getSummary() → 对话摘要
  │  L2: memoryService.recall() → ES/SQLite 情景记忆
  │  L3: getCoreMemory() → 核心记忆 (relationshipStage + keyFacts 前 3 项)
  │   ▸ [4] build_prompt
  │  buildSystemPrompt() 构建角色扮演提示词
  │  ├── 身份、性格、自称、语气、典型表达
  │  ├── 禁用词、禁用风格
  │  ├── 世界知识、关系设定、情感弧线
  │  ├── 提示注入防护规则（不可信参考领域）
  │  └── 群聊模式: 附加 groupContext
  │   ▸ [5] call_llm_stream
  │  deepSeekService.streamStructuredCompletion()
  │  ├── temperature: 0.7
  │  ├── JSON 结构化输出: { content, speechTextJa, nextSpeaker? }
  │  ├── 流式增量提取 content 字段 → SSE token 推送
  │  └── 流结束后完整解析 JSON → 返回 content / speechTextJa / nextSpeaker
  │   ▸ [6] validate_response
  │  检查: 是否包含 forbiddenWords / 是否缺少 selfAddress
  │  ├── 有问题 && retryCount < 1 → 回到 [4] build_prompt (重试 1 次)
  │  └── 通过 → 继续
  │   ▸ [7] save_message
  │  构建 ChatMessageMetadata (检索+记忆计数 + speechTextJa + attachments)
  │  repository.appendMessage() → 写入 SQLite
  │  SSE 推送 message_done
  │  scheduleAssistantAudio() → fire-and-forget TTS 合成
  │   ▸ END
```

## 条件边

```
validate_response 后
  state.validationIssue && state.retryCount < 1
    → build_prompt (重试生成)
    → save_message (保存)
```

## 节点职责说明

### prepare_turn
确定当前应该由哪个角色发言，从数据库加载对应的 `CharacterProfile`，重置本轮输出缓冲区。SSE 推送状态通知前端。

### retrieve_context
构建检索查询语句，调用 `ElasticsearchService.hybridSearch()` 执行三路混合检索：
- **dense_vector**: cosineSimilarity，基于 bge-m3 (1024 维)
- **BM25**: multi_match on text / text_norm / all_tags 字段
- **Tag matching**: 标签精确匹配（scene / emotion / function / tone）
- **RRF 融合排序**: score = 1 / (60 + rank + 1)，按总分降序取 top-K

### retrieve_memory
三层记忆检索并行执行：
- L1: 读取当前 session 的对话摘要
- L2: 从 ES/SQLite 检索情景记忆片段
- L3: 读取核心记忆（关系阶段、关键事实）

### build_prompt
构建最终的 LLM 提示词，包含角色设定、对话历史、检索结果、记忆信息。支持群聊模式下附加 `groupContext`。

### call_llm_stream
调用 DeepSeek API，使用 SSE 流式传输 token，逐步渲染到前端。输出为结构化 JSON。

### validate_response
对 LLM 输出进行合规性检查，检测禁用词、确保包含自称等。失败时自动重试一次。

### save_message
将最终消息写入 SQLite，触发 TTS 异步合成，推送消息完成事件。
