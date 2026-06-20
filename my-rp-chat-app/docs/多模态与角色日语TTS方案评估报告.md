# 多模态与角色日语 TTS 方案评估报告

## 评估结论
这份多模态与角色日语 TTS 方案**非常可行**，且与当前项目的架构现状高度契合。

## 具体的评估分析

### 1. 架构兼容性（极高）
* **数据库层面**：现有的 `messages` 表已经设计了 `metadata_json` 字段，这使得引入图片（`attachments`）和音频元数据（`audio`）**完全不需要修改表结构或进行数据库迁移**。
* **类型系统**：`src/common/types.ts` 中的 `ChatMessage` 已经拥有 `metadata?: Record<string, unknown>`，只需将其具体化即可，对现有代码侵入性很小。

### 2. 流式与事件体系扩展性（极高）
* **SSE 链路**：目前 `src/backend/services/stream/sse-service.ts` 实现了一套标准的发布订阅机制。方案中提到新增 `audio_ready` 事件，只需在 `StreamEvent` 联合类型中扩展并在此服务中直接触发即可。前端 `useChatStream` 监听此事件刷新消息，逻辑十分闭环。
* **异步 TTS 策略**：方案明确提到**不阻塞文本流**，把 TTS 放在助手消息落库后异步进行。这完美适配了现有的 LangGraph 编排流程，只需在 `chat-graphs.ts` 的 `save_message` 节点之后发起 TTS 任务，不影响当前的流式响应速度。

### 3. 文件存储策略（合理）
* **媒体落盘**：将图片和生成的音频落盘到 `userData/media/` 目录下，而非塞入 SQLite，这有效避免了 SQLite 的体积膨胀和性能下降。
* **前端渲染**：在 Electron 中，前端只需配合注册一个自定义协议（如 `rp-media://`）或通过预加载层，就可以非常方便地读取和播放这些本地文件。

---

## ⚠️ 需要注意的实施难点（工程挑战）

尽管方案整体非常可行，但在实际开发中有一个具体的**技术难点需要特别关注**：

**LLM 流式 JSON 输出与前端打字机效果的冲突处理**
方案提到要求 LLM 一次性输出：
```json
{
  "content": "今天有点冷...",
  "speechTextJa": "今日は少し寒いですから..."
}
```
* **现状**：目前 `llmService.streamCompletion` 是直接把拿到的 token 推给 `sse-service`，前端直接追加渲染。
* **挑战**：如果 LLM 改为输出 JSON，你接收到的流将包含 `{"content": "` 这样的结构字符，不能直接推给前端，否则前端会看到 JSON 源码。
* **解决建议**：在 `call_llm_stream` 节点中，你需要引入一个**流式 JSON 解析器**（或简单的正则状态机），只有当解析到 `content` 字段内的增量文本时，才触发 `token` 事件推送给前端。当整个 JSON 输出完毕后，再提取出完整的 `speechTextJa`，在 `save_message` 节点传递给 `TtsService`。

## 总结
该方案**设计克制、切中痛点、且最大程度复用了现有链路**。只要处理好流式 JSON 的解析问题，按照方案中的 4 个实施阶段逐步推进，可以非常平滑地为当前的 Electron 聊天应用加入多模态与高质量角色语音能力。完全体能力。
