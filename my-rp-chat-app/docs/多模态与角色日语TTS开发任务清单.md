# 多模态与角色日语 TTS 开发任务清单

## 1. 说明

本文档基于 [多模态与角色日语TTS方案.md](file:///f:/yoshino/my-rp-chat-app/docs/%E5%A4%9A%E6%A8%A1%E6%80%81%E4%B8%8E%E8%A7%92%E8%89%B2%E6%97%A5%E8%AF%ADTTS%E6%96%B9%E6%A1%88.md) 拆解为可执行开发任务，目标是让开发过程具备以下特征：

- 任务粒度足够细，可直接进入编码
- 每一阶段都有明确产出
- 每个任务都标注涉及文件和验收标准
- 优先实现最小闭环，再逐步扩展

建议按本文档顺序推进，不要一开始同时做所有能力。

## 2. 任务总览

推荐分 5 个阶段执行：

1. 基础扩展准备
2. 助手消息异步 TTS 闭环
3. 中文显示 + 日语朗读闭环
4. 图片附件发送与渲染闭环
5. 结构收敛、补测试、补文档

## 3. 阶段 0：准备与约束确认

### 任务 0.1：确认 TTS 接入策略

- 目标：确定首版使用的 TTS Provider
- 推荐选择：
  - 快速验证：商业 API
  - 长期方案：`Qwen3-TTS`
  - 离线优先：本地日语 TTS
- 产出：
  - 一份最终选型说明
  - 对应环境变量清单
- 验收标准：
  - 明确 `TTS_PROVIDER`
  - 明确是否需要 `API Key`
  - 明确是否支持角色音色映射

### 任务 0.2：确认媒体目录策略

- 目标：确定图片和音频文件的存储目录
- 推荐结论：
  - 默认使用 `app.getPath("userData")/media`
- 产出：
  - 目录结构说明
  - 命名规则说明
- 验收标准：
  - 明确图片保存目录
  - 明确音频保存目录
  - 明确清理策略是否需要首版支持

## 4. 阶段 1：基础扩展准备

本阶段不做完整功能，只完成类型、配置和基础能力扩展，给后续任务打地基。

### 任务 1.1：扩展公共类型定义

- 目标：给消息补充附件、音频、朗读稿等结构
- 涉及文件：
  - `src/common/types.ts`
- 建议新增：
  - `MessageAttachment`
  - `MessageAudio`
  - `ChatMessageMetadata`
  - `PendingAttachmentInput`
  - `StreamAudioReadyPayload`
  - `StreamAudioFailedPayload`
- 关键改动：
  - 扩展 `ChatRequest`
  - 扩展 `ChatMessage.metadata`
  - 扩展 `StreamEvent`
- 前置依赖：
  - 无
- 验收标准：
  - TypeScript 类型可编译
  - 不破坏现有文本消息链路

### 任务 1.2：扩展后端配置项

- 目标：为媒体目录和 TTS 提供配置入口
- 涉及文件：
  - `src/backend/config.ts`
  - `.env.example`
- 建议新增配置：
  - `MEDIA_DIR`
  - `TTS_PROVIDER`
  - `TTS_API_KEY`
  - `TTS_BASE_URL`
  - `TTS_MODEL`
  - `TTS_DEFAULT_VOICE`
  - `TTS_CHARACTER_VOICE_MAP`
- 前置依赖：
  - 任务 1.1
- 验收标准：
  - 配置对象可读出新增字段
  - 为空时有合理默认值

### 任务 1.3：补充数据库消息更新能力

- 目标：为后续异步更新音频状态和附件元数据做准备
- 涉及文件：
  - `src/backend/db/database.ts`
- 建议新增方法：
  - `updateMessageMetadata(messageId, metadata)`
  - `updateMessageAudio(messageId, audio)`
  - 如有需要，`getMessageById(messageId)`
- 前置依赖：
  - 任务 1.1
- 验收标准：
  - 能对单条消息更新 `metadata_json`
  - 原有 `appendMessage`、`listMessages` 行为不受影响

### 任务 1.4：增加媒体路径工具

- 目标：统一生成图片、音频文件保存路径
- 涉及文件：
  - `src/backend/services/media/` 下新增工具文件
  - 或 `src/backend/app-runtime.ts` 内部先落简单工具
- 建议新增能力：
  - `resolveMediaRoot()`
  - `resolveImagePath(chatId, messageId, attachmentId, ext)`
  - `resolveAudioPath(chatId, messageId, ext)`
- 前置依赖：
  - 任务 1.2
- 验收标准：
  - 可稳定生成目录
  - 自动创建不存在的目录

## 5. 阶段 2：助手消息异步 TTS 闭环

本阶段目标是先跑通“助手消息生成后，聊天气泡里出现语音播放器”。

### 任务 2.1：新增 TTS 服务接口

- 目标：抽离统一 TTS 服务，不把调用逻辑散落在图节点里
- 涉及文件：
  - `src/backend/services/tts/tts-service.ts`
  - 如采用不同实现，可新增：
    - `src/backend/services/tts/providers/...`
- 建议接口：

```ts
interface SynthesizeInput {
  chatId: string;
  messageId: string;
  roleId?: string | null;
  text: string;
}

interface SynthesizeResult {
  voiceId: string;
  relativePath: string;
  mimeType: string;
  durationMs?: number;
}
```

- 前置依赖：
  - 任务 1.2
  - 任务 1.4
- 验收标准：
  - 服务可单独被调用
  - 失败时抛出明确错误

### 任务 2.2：在运行时注册 TTS 服务

- 目标：将 `TtsService` 注入到现有运行时与图依赖中
- 涉及文件：
  - `src/backend/app-runtime.ts`
  - `src/backend/graph/chat-graphs.ts`
- 前置依赖：
  - 任务 2.1
- 验收标准：
  - 图节点可以访问 `ttsService`
  - 不影响当前单聊和群聊初始化

### 任务 2.3：为 SSE 增加音频完成事件

- 目标：让前端在 TTS 完成后能刷新当前消息
- 涉及文件：
  - `src/common/types.ts`
  - `src/backend/services/stream/sse-service.ts`
- 建议新增事件：
  - `audio_ready`
  - 可选 `audio_failed`
- 前置依赖：
  - 任务 1.1
- 验收标准：
  - SSE 能正确 publish 新事件
  - 原有 `token`、`message_done`、`error` 不受影响

### 任务 2.4：助手消息落库时写入音频占位状态

- 目标：让前端能够显示“语音生成中”
- 涉及文件：
  - `src/backend/graph/chat-graphs.ts`
- 改动点：
  - `save_message` 节点中，保存助手消息时附带：
    - `metadata.audio.status = "pending"`
- 前置依赖：
  - 任务 1.1
  - 任务 1.3
- 验收标准：
  - 助手消息落库后立即带有 `audio.pending`

### 任务 2.5：消息落库后异步触发 TTS

- 目标：不阻塞文本主链路
- 涉及文件：
  - `src/backend/graph/chat-graphs.ts`
  - `src/backend/app-runtime.ts`
  - `src/backend/services/tts/tts-service.ts`
- 实现建议：
  - 在消息保存后 fire-and-forget 调用 TTS
  - 成功后更新消息 `metadata.audio`
  - 再通过 SSE 发布 `audio_ready`
- 前置依赖：
  - 任务 2.1
  - 任务 2.3
  - 任务 2.4
- 验收标准：
  - 文本回复先出现
  - 稍后同一条消息变为可播放

### 任务 2.6：前端监听音频完成事件

- 目标：前端在不刷新整个应用的情况下看到音频状态变化
- 涉及文件：
  - `src/renderer/hooks/useChatStream.ts`
- 改动点：
  - 新增 `audio_ready` 监听
  - 收到后调用 `onMessagesChanged`
- 前置依赖：
  - 任务 2.3
- 验收标准：
  - 音频完成后消息列表自动刷新

### 任务 2.7：在消息气泡里渲染音频播放器

- 目标：聊天气泡显示语音状态和播放器
- 涉及文件：
  - `src/renderer/components/ChatWorkspace.tsx`
  - 如需样式，`src/renderer/App.css`
- 首版建议：
  - `pending` 显示文本提示
  - `ready` 渲染 `<audio controls>`
  - `failed` 显示失败提示
- 前置依赖：
  - 任务 2.6
- 验收标准：
  - 助手消息可以显示音频状态
  - 成功后可直接播放本地音频

### 任务 2.8：补充 TTS 相关测试

- 目标：确保异步更新链路稳定
- 涉及文件：
  - `tests/` 下新增或修改测试
- 建议测试：
  - `database` 消息元数据更新测试
  - `sse-service` 新事件测试
  - `chat-graphs` 中异步 TTS 触发测试
- 前置依赖：
  - 阶段 2 主体完成
- 验收标准：
  - 关键测试通过

## 6. 阶段 3：中文显示 + 日语朗读闭环

本阶段目标是让角色“显示中文，朗读日语”。

### 任务 3.1：定义消息中的日语朗读稿字段

- 目标：为助手消息增加 `speechTextJa`
- 涉及文件：
  - `src/common/types.ts`
- 建议落点：
  - `ChatMessage.metadata.speechTextJa`
- 前置依赖：
  - 任务 1.1
- 验收标准：
  - 不影响现有 `content` 文本渲染

### 任务 3.2：调整 LLM 输出结构

- 目标：让模型同时输出中文显示文本和日语朗读稿
- 涉及文件：
  - `src/backend/services/llm/deepseek-service.ts`
  - `src/backend/graph/chat-graphs.ts`
- 建议方式：
  - 输出 JSON
  - 结构至少包含：
    - `content`
    - `speechTextJa`
- 前置依赖：
  - 任务 3.1
- 验收标准：
  - 模型返回结构稳定可解析
  - 出错时可降级为仅中文文本

### 任务 3.3：调整 Prompt 约束

- 目标：让模型写出“可读的中文”和“可念的日语”
- 涉及文件：
  - `src/backend/graph/chat-graphs.ts`
  - 如有 Prompt 模板文件，也需同步调整
- Prompt 要求：
  - `content` 是自然中文
  - `speechTextJa` 是自然日语口语
  - 保持角色口癖、称呼和语气一致
- 前置依赖：
  - 任务 3.2
- 验收标准：
  - 角色语气在中日双文本中保持一致

### 任务 3.4：TTS 改为读取 `speechTextJa`

- 目标：不再让 TTS 直接吃中文文本
- 涉及文件：
  - `src/backend/services/tts/tts-service.ts`
  - `src/backend/graph/chat-graphs.ts`
- 改动点：
  - 优先使用 `speechTextJa`
  - 若缺失则降级使用 `content`
- 前置依赖：
  - 任务 3.2
- 验收标准：
  - 页面显示中文
  - 播放时输出日语

### 任务 3.5：补充角色音色映射

- 目标：不同角色使用不同 voice
- 涉及文件：
  - `src/backend/config.ts`
  - `src/backend/services/tts/tts-service.ts`
  - `.env.example`
- 建议方式：
  - `TTS_CHARACTER_VOICE_MAP` 以 JSON 配置
- 前置依赖：
  - 任务 2.1
- 验收标准：
  - 至少 2 个角色可使用不同 voice

### 任务 3.6：补充日语朗读链路测试

- 目标：验证双文本结构和降级策略
- 涉及文件：
  - `tests/` 下新增或修改测试
- 建议测试：
  - LLM 输出解析测试
  - `speechTextJa` 缺失时降级测试
  - 角色 voice 选择测试
- 前置依赖：
  - 阶段 3 主体完成
- 验收标准：
  - 关键双文本逻辑可测试通过

## 7. 阶段 4：图片附件发送与渲染闭环

本阶段目标是支持图片发送、存储与聊天气泡渲染。

### 任务 4.1：定义前端待上传附件结构

- 目标：让渲染层可以持有临时图片状态
- 涉及文件：
  - `src/common/types.ts`
  - 视需要新增前端本地类型
- 字段建议：
  - `id`
  - `name`
  - `mimeType`
  - `size`
  - `localPath` 或 `dataUrl`
- 前置依赖：
  - 任务 1.1
- 验收标准：
  - 前端可维护已选图片列表

### 任务 4.2：在输入区加入图片选择与预览

- 目标：用户可以在发送前选择图片并看到预览
- 涉及文件：
  - `src/renderer/components/ChatWorkspace.tsx`
  - `src/renderer/App.tsx`
  - 如需样式，`src/renderer/App.css`
- 建议能力：
  - 上传按钮
  - 预览缩略图
  - 删除已选图片
- 前置依赖：
  - 任务 4.1
- 验收标准：
  - 可选图
  - 可预览
  - 可移除

### 任务 4.3：扩展发送链路支持附件

- 目标：前端发送文本时可附带图片
- 涉及文件：
  - `src/renderer/App.tsx`
  - `src/renderer/hooks/useChatStream.ts`
  - `src/preload/index.ts`
  - `src/main/index.ts`
- 前置依赖：
  - 任务 1.1
  - 任务 4.2
- 验收标准：
  - `chat:send` 可接收附件字段

### 任务 4.4：实现图片保存逻辑

- 目标：将图片文件保存到媒体目录
- 涉及文件：
  - `src/backend/app-runtime.ts`
  - `src/backend/services/media/...`
- 建议实现：
  - 保存到 `userData/media/images/{chatId}/`
  - 生成稳定文件名
  - 返回 `relativePath`
- 前置依赖：
  - 任务 1.4
  - 任务 4.3
- 验收标准：
  - 图片实际落盘
  - 路径能被后续消息渲染使用

### 任务 4.5：用户消息写入附件元数据

- 目标：图片进入聊天历史
- 涉及文件：
  - `src/backend/app-runtime.ts`
  - `src/backend/db/database.ts`
- 改动点：
  - 用户消息写入 `metadata.attachments`
  - `content` 无文本时可写 `[图片]`
- 前置依赖：
  - 任务 4.4
- 验收标准：
  - 重启应用后历史图片消息仍可读出

### 任务 4.6：历史消息渲染图片附件

- 目标：已发送图片能在聊天气泡中展示
- 涉及文件：
  - `src/renderer/components/ChatWorkspace.tsx`
- 建议：
  - 文本下方渲染图片缩略图
  - 点击后可查看原图或更大预览
- 前置依赖：
  - 任务 4.5
- 验收标准：
  - 历史消息中能看到图片

### 任务 4.7：补充图片链路测试

- 目标：保证图片消息持久化正常
- 涉及文件：
  - `tests/database.test.ts`
  - `tests/app-runtime.test.ts`
  - 其他相关测试文件
- 建议测试：
  - 附件元数据落库测试
  - 图片消息读取测试
- 前置依赖：
  - 阶段 4 主体完成
- 验收标准：
  - 图片主链路可覆盖基本测试

## 8. 阶段 5：结构收敛与增强

### 任务 5.1：抽离媒体与附件公共工具

- 目标：减少图片、音频处理逻辑分散
- 涉及文件：
  - `src/backend/services/media/...`
  - `src/renderer/utils/...`
- 前置依赖：
  - 阶段 2、4 完成
- 验收标准：
  - 媒体路径、媒体 URL、元数据工具集中管理

### 任务 5.2：决定是否升级为统一附件模型

- 目标：评估是否将 `audio` 与 `attachments` 合并
- 方案：
  - 保守方案：`metadata.audio + metadata.attachments`
  - 统一方案：全部进入 `attachments`
- 前置依赖：
  - 阶段 2、4 完成
- 验收标准：
  - 形成最终数据模型结论

### 任务 5.3：补充重试与失败处理

- 目标：提升稳定性
- 涉及文件：
  - `src/backend/services/tts/tts-service.ts`
  - `src/renderer/components/ChatWorkspace.tsx`
- 建议补充：
  - 语音生成失败提示
  - 重新生成语音入口
  - 图片保存失败提示
- 前置依赖：
  - 阶段 2、4 完成
- 验收标准：
  - 出错时有可见反馈

### 任务 5.4：补充发音词典或角色读音表

- 目标：提升日语读音准确性
- 涉及文件：
  - `src/backend/services/tts/...`
  - `src/backend/graph/chat-graphs.ts`
  - 视需要新增配置文件
- 适用对象：
  - 角色名
  - 地名
  - 专有名词
- 前置依赖：
  - 阶段 3 完成
- 验收标准：
  - 至少若干关键专名可稳定读对

### 任务 5.5：更新文档与 README

- 目标：让新功能可被开发者理解与使用
- 涉及文件：
  - `README.md`
  - `docs/多模态与角色日语TTS方案.md`
  - 本任务清单文档
- 需补内容：
  - 新环境变量
  - TTS 配置说明
  - 图片与音频存储说明
  - 使用与排错说明
- 前置依赖：
  - 全部主要功能完成
- 验收标准：
  - 开发者可按文档完成配置和运行

## 9. 建议开发顺序

如果希望尽快看到效果，建议按如下顺序推进：

1. `任务 1.1` 到 `任务 1.4`
2. `任务 2.1` 到 `任务 2.7`
3. `任务 3.1` 到 `任务 3.5`
4. `任务 4.1` 到 `任务 4.6`
5. 最后完成测试、文档和失败处理

对应里程碑：

- 里程碑 A：助手消息能播语音
- 里程碑 B：界面中文，朗读日语
- 里程碑 C：图片能发、能存、能显示

## 10. 最小可运行闭环定义

如果要先做一个 MVP，建议范围如下：

### MVP-1：异步 TTS

- 助手消息保存后异步合成音频
- 气泡里显示播放器
- 暂不做语音重试

### MVP-2：中文显示 + 日语朗读

- 助手消息保留 `content`
- 新增 `speechTextJa`
- TTS 优先使用 `speechTextJa`

### MVP-3：图片消息

- 用户可选择单张图片
- 图片保存到本地
- 消息历史中可查看图片

## 11. 可直接开工的首批任务

如果现在立刻进入编码，建议第一批只做下面 6 个任务：

1. 扩展 `src/common/types.ts`
2. 扩展 `src/backend/config.ts` 和 `.env.example`
3. 扩展 `src/backend/db/database.ts` 的消息元数据更新方法
4. 新增 `src/backend/services/tts/tts-service.ts`
5. 在 `src/backend/graph/chat-graphs.ts` 中接入异步 TTS
6. 在 `src/renderer/components/ChatWorkspace.tsx` 中渲染音频状态和播放器

完成这 6 个任务后，项目就会具备第一版“聊天气泡角色语音”能力。
