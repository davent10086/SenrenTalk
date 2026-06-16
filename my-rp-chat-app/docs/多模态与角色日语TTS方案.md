# 多模态与角色日语 TTS 方案

## 1. 目标

本文档结合当前项目现状，给出一套可在现有 `Electron + React + TypeScript + LangGraph + SQLite + SSE` 架构上落地的增强方案，目标包括：

- 支持聊天中的图片附件
- 支持聊天气泡中的角色语音播放
- 支持“界面显示中文消息，但角色朗读为自然日语”
- 尽量复用现有消息流、SSE、SQLite 与 LangGraph 链路
- 采用最小可运行闭环优先、逐步增强的实施策略

## 2. 当前项目现状

当前项目的关键约束如下：

- 消息结构仍以 `content: string` 为中心
- 前端 `ChatWorkspace` 只支持文本输入和文本渲染
- 后端 `ChatRequest` 仅接收纯文本
- SQLite `messages` 表仅保存 `content` 与 `metadata_json`
- SSE 目前仅有 `token`、`message_done`、`error` 三类事件
- 助手消息在 LangGraph 的 `save_message` 节点落库后，通过 `message_done` 通知前端刷新

这意味着多模态和 TTS 都不适合硬塞进现有纯文本字段，而应在兼容现有逻辑的基础上引入结构化扩展。

## 3. 总体设计原则

### 3.1 消息显示与媒体资源分离

- 文本内容继续保留 `content`
- 图片、音频等媒体资源以结构化字段保存
- 文件本体存磁盘
- 数据库存元数据和相对路径

### 3.2 文本消息与语音消息分离

“中文显示、日语朗读”不应依赖单一文本字段完成，而应拆成两份文本：

- `content`: 展示给用户的中文文本
- `speechTextJa`: 提供给 TTS 的日语朗读稿

### 3.3 文本主链路优先

- 文字回复优先完成并显示
- 图片上传与音频合成尽量异步
- 不阻塞当前 SSE 文本流

### 3.4 兼容现有项目结构

优先增量修改以下模块，而不是推翻重构：

- `src/common/types.ts`
- `src/renderer/components/ChatWorkspace.tsx`
- `src/renderer/App.tsx`
- `src/renderer/hooks/useChatStream.ts`
- `src/preload/index.ts`
- `src/main/index.ts`
- `src/backend/app-runtime.ts`
- `src/backend/graph/chat-graphs.ts`
- `src/backend/db/database.ts`
- `src/backend/services/stream/sse-service.ts`

## 4. 图片存储方案

## 4.1 结论

图片采用“文件落盘 + 数据库存路径”的方式，不直接存入 SQLite 的 BLOB，也不存 Base64。

原因：

- SQLite 体积会快速膨胀
- Base64 存储和传输成本更高
- 文件落盘更适合预览、删除、迁移、压缩和后续扩展

## 4.2 存储位置

建议使用 Electron 的 `app.getPath("userData")` 目录作为应用私有数据目录。

推荐目录结构：

```text
userData/
  rp-chat.sqlite
  media/
    images/
      {chatId}/
        {messageId}-{attachmentId}.jpg
    audio/
      {chatId}/
        {messageId}.mp3
```

其中：

- 数据库仍保存到 `userData/rp-chat.sqlite`
- 图片文件存入 `userData/media/images/...`
- TTS 音频存入 `userData/media/audio/...`

## 4.3 图片元数据结构

建议先定义统一附件类型：

```ts
export type AttachmentKind = "image" | "audio" | "file";

export interface MessageAttachment {
  id: string;
  kind: AttachmentKind;
  originalName: string;
  mimeType: string;
  size: number;
  relativePath: string;
  width?: number;
  height?: number;
  durationMs?: number;
}
```

图片场景下主要使用：

- `id`
- `kind = "image"`
- `originalName`
- `mimeType`
- `size`
- `relativePath`
- `width`
- `height`

## 4.4 数据库存储策略

首版建议继续利用现有 `messages.metadata_json` 字段，先把附件数组挂入 `metadata`，避免一次性新增复杂表结构。

建议格式：

```ts
export interface ChatMessageMetadata {
  attachments?: MessageAttachment[];
  audio?: MessageAudio;
  retrievedCount?: number;
  memoryCount?: number;
}
```

后续若附件能力扩展较多，再升级为独立表：

```text
message_attachments
- id
- message_id
- kind
- original_name
- mime_type
- size
- relative_path
- width
- height
- duration_ms
```

## 4.5 图片发送流程

### 前端

1. 在输入框旁增加图片选择按钮
2. 用户选图后显示本地预览
3. 发送消息时一并提交文本和附件

### 后端

1. 收到附件后保存文件到 `userData/media/images/...`
2. 返回附件元数据
3. 将元数据写入消息 `metadata.attachments`
4. `content` 保留用户文本；若没有文本，可保存为 `[图片]`

### 历史消息渲染

前端读取消息后：

- 正常显示文本
- 如果 `metadata.attachments` 中有 `image`，在气泡中渲染缩略图

## 5. 角色语音方案

## 5.1 结论

角色语音应作为“助手消息的附加资源”处理，而不是单独再插一条纯语音消息。

推荐策略：

- 文本按现有 SSE 链路流式显示
- 助手消息落库后异步生成语音
- 语音生成完成后更新该消息的音频元数据
- 前端在同一个聊天气泡中显示播放控件

## 5.2 为什么不阻塞文本流

当前项目的文本体验已经建立在以下链路上：

- LangGraph 输出 token
- SSE 推送 `token`
- 生成完成后写入消息
- SSE 推送 `message_done`
- 前端刷新消息列表

如果把 TTS 合成放在文本主链路中，会带来以下问题：

- 用户要等语音合成完成后才能看到回复
- 群聊场景下延迟会更高
- SSE 语义会变得混乱

因此应采用异步 TTS 支路。

## 5.3 音频元数据结构

```ts
export interface MessageAudio {
  status: "pending" | "ready" | "failed";
  voiceId: string;
  relativePath?: string;
  mimeType?: string;
  durationMs?: number;
  error?: string;
}
```

建议将其挂在：

```ts
metadata.audio
```

## 5.4 TTS 触发时机

建议在助手消息保存之后触发：

1. `save_message` 节点先把文本消息落库
2. 初始写入 `metadata.audio.status = "pending"`
3. 异步调用 `TtsService`
4. 合成完成后更新该消息为 `ready`
5. 通知前端刷新当前消息

## 5.5 前端呈现方式

在聊天气泡中，文字下方增加音频区域：

- `pending`: 显示“语音生成中”
- `ready`: 显示播放按钮或 `<audio controls>`
- `failed`: 显示“语音生成失败，可重试”

首版建议直接使用原生：

```html
<audio controls src="..."></audio>
```

后续再升级成更像聊天产品的播放器样式。

## 6. 中文显示、日语朗读的设计

## 6.1 目标

用户在界面中看到的是自然中文聊天内容，但角色朗读出来的是自然日语，而不是中文按日语音色硬读。

## 6.2 关键原则

不要直接拿中文文本去做日语 TTS。

正确方式是：

- 中文用于阅读
- 日语用于发音

因此一条助手消息需要至少包含两份文本：

```ts
export interface AssistantSpeechPayload {
  content: string;
  speechTextJa?: string;
}
```

## 6.3 为什么必须拆两份文本

若直接把中文交给日语 TTS，常见问题包括：

- 按中文发音念出
- 韵律不自然
- 人名、称呼、语气词读错
- 角色口癖和语气丢失

拆分之后的优势：

- 中文可以更符合用户阅读习惯
- 日语朗读稿可以更适合口语表达
- 可对角色口癖、称呼、语气单独优化

## 6.4 推荐生成方式

建议由 LLM 一次性输出两个字段：

```json
{
  "content": "今天有点冷，你要不要多穿一点？",
  "speechTextJa": "今日は少し寒いですから、もう少し暖かくしたほうがいいですよ。"
}
```

要求模型：

- `content` 使用自然中文
- `speechTextJa` 使用自然日语口语
- 保持角色设定、语气和关系称呼一致
- 对人名、地名、专有名词尽量给出稳定说法

## 6.5 更进一步的增强

后续可以继续增加：

- `speechKana`
- `phonemes`
- 发音词典

适用于：

- 角色名固定读法
- 游戏术语固定读法
- 假名和重音精确控制

## 7. TTS 引擎推荐

## 7.1 推荐顺序

### 方案 A：Qwen3-TTS

适合当前项目的长期方案，原因：

- 支持多语言
- 支持角色化音色
- 支持语音克隆和定制音色
- 可以作为本地部署或 API 方案
- 更适合后续做“角色语音”而不是普通播报

适合场景：

- 希望后续继续扩展角色个性化
- 希望中日双语、多角色统一处理
- 希望长期可控

### 方案 B：ElevenLabs / MiniMax Speech

适合快速验证产品体验：

- 成品质量通常更稳定
- 音色和情绪控制成熟
- 接入速度快

适合场景：

- 优先追求成品音质
- 可以接受商业 API 成本
- 首版目标是尽快做出体验

### 方案 C：Piper Plus 或日语本地链路

适合离线优先：

- 适合本地部署
- 日语支持路径明确
- 更容易控制私有化

适合场景：

- 必须离线运行
- 希望先把日语播放跑通
- 对商业 API 依赖敏感

## 7.2 结合本项目的推荐

若以当前项目为基线，推荐优先级如下：

1. 首版快速验证：商业 TTS API
2. 中期稳定方案：Qwen3-TTS
3. 离线私有化备选：Piper Plus / 本地日语 TTS

如果只选一个作为长期方向，推荐 `Qwen3-TTS`。

## 8. SSE 事件扩展方案

当前项目已有事件：

- `token`
- `message_done`
- `error`

为了支持异步语音完成通知，建议新增：

```ts
export interface StreamAudioReadyPayload {
  type: "audio_ready";
  streamId: string;
  messageId: string;
  roleId?: string | null;
  relativePath: string;
}
```

可选地再增加失败事件：

```ts
export interface StreamAudioFailedPayload {
  type: "audio_failed";
  streamId: string;
  messageId: string;
  roleId?: string | null;
  error: string;
}
```

前端处理方式：

- 监听 `audio_ready`
- 收到后刷新当前聊天消息
- 对应消息气泡显示播放器

## 9. 类型设计建议

建议逐步把消息类型扩展为：

```ts
export interface ChatMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  roleId?: string | null;
  metadata?: ChatMessageMetadata;
}

export interface ChatMessageMetadata {
  attachments?: MessageAttachment[];
  audio?: MessageAudio;
  speechTextJa?: string;
  retrievedCount?: number;
  memoryCount?: number;
}

export interface ChatRequest {
  chatId: string;
  content: string;
  mode: ChatMode;
  participants: string[];
  mentionTarget?: string | null;
  attachments?: PendingAttachmentInput[];
}
```

首版先不强推 `contentParts`，以减少对现有检索与记忆链路的冲击。

后续若真正进入完整多模态阶段，再升级为：

- `content`
- `parts`
- `attachments`

三层共存模型。

## 10. 分文件改造建议

## 10.1 `src/common/types.ts`

新增：

- `MessageAttachment`
- `MessageAudio`
- `ChatMessageMetadata`
- `attachments` 输入结构
- `audio_ready` 相关 SSE 类型

## 10.2 `src/renderer/components/ChatWorkspace.tsx`

改造：

- 输入区增加图片上传按钮
- 消息区支持图片预览
- 消息区支持音频播放器
- 助手消息支持显示“语音生成中”

## 10.3 `src/renderer/App.tsx`

改造：

- `sendCurrentMessage` 支持附件
- 乐观更新消息时保留附件预览信息

## 10.4 `src/renderer/hooks/useChatStream.ts`

改造：

- `sendMessage` 支持附件字段
- 监听 `audio_ready`
- 收到音频完成事件后刷新消息

## 10.5 `src/preload/index.ts`

新增能力：

- 选择图片
- 保存附件
- 如有需要，暴露音频重试生成接口

## 10.6 `src/main/index.ts`

新增 IPC：

- `attachment:save`
- `attachment:pick`
- `message:tts-regenerate`（可选）

## 10.7 `src/backend/config.ts`

新增配置：

- `MEDIA_DIR`
- `TTS_PROVIDER`
- `TTS_API_KEY`
- `TTS_BASE_URL`
- `TTS_MODEL`

可选增加：

- `TTS_DEFAULT_VOICE`
- `TTS_CHARACTER_VOICE_MAP`

## 10.8 `src/backend/app-runtime.ts`

改造：

- 接收附件输入
- 保存图片
- 写入用户消息元数据
- 必要时生成 `[图片]` 之类的摘要内容

## 10.9 `src/backend/graph/chat-graphs.ts`

改造：

- 助手回复除 `content` 外，支持 `speechTextJa`
- `save_message` 写入 `metadata.audio.status = "pending"`
- 消息保存后触发异步 TTS

## 10.10 `src/backend/db/database.ts`

改造：

- 保持 `messages` 表不动，先利用 `metadata_json`
- 增加更新消息元数据的方法，例如：
  - `updateMessageMetadata`
  - `updateMessageAudio`

## 10.11 `src/backend/services/tts/tts-service.ts`

新增服务：

- 输入：`roleId`、`text`、`messageId`、`chatId`
- 输出：音频文件元数据
- 负责：
  - 选 voice
  - 调用 TTS
  - 落盘到 `userData/media/audio/...`
  - 返回 `relativePath`

## 10.12 `src/backend/services/stream/sse-service.ts`

改造：

- 支持 `audio_ready`
- 可选支持 `audio_failed`

## 11. 推荐实施阶段

## 阶段 1：先实现聊天气泡语音

范围：

- 助手消息支持 `metadata.audio`
- 新增 `TtsService`
- 音频文件落盘
- 前端渲染 `<audio controls>`

验收：

- 助手回复完成后，气泡里出现播放器

## 阶段 2：实现中文显示、日语朗读

范围：

- LLM 输出 `content + speechTextJa`
- TTS 改为吃 `speechTextJa`

验收：

- 聊天气泡显示中文
- 播放语音时为自然日语

## 阶段 3：实现图片发送与预览

范围：

- 前端加选图
- 文件保存到 `media/images`
- 消息气泡支持图片预览

验收：

- 用户能发送图片并在历史消息里看到

## 阶段 4：完善多模态消息结构

范围：

- 评估是否引入 `MessagePart[]`
- 将图片、音频、文件统一到附件层

验收：

- 图片、语音和普通文件具备一致的存储和渲染模型

## 12. 对记忆与检索链路的处理建议

当前记忆与检索强依赖 `message.content`，因此首版不要强制重写所有链路。

建议策略：

- 用户发图片但无文本时，写入简短摘要，如 `[图片]`
- 若用户有文本说明，`content` 保留文本说明
- TTS 的 `speechTextJa` 不作为检索主文本
- 记忆提取仍优先读取 `content`

这样可以最大程度兼容：

- LangGraph prompt 构造
- 记忆抽取
- ES 检索
- 历史消息展示

## 13. 环境变量建议

建议在 `.env.example` 增加：

```env
MEDIA_DIR=
TTS_PROVIDER=qwen
TTS_API_KEY=
TTS_BASE_URL=
TTS_MODEL=
TTS_DEFAULT_VOICE=
TTS_CHARACTER_VOICE_MAP=
```

说明：

- `MEDIA_DIR` 为空时默认回退到 `userData/media`
- `TTS_CHARACTER_VOICE_MAP` 可存 JSON 字符串

示例：

```json
{
  "芳乃": "voice_yoshino",
  "茉子": "voice_mako",
  "丛雨": "voice_murasame"
}
```

## 14. 风险与注意事项

### 14.1 不要把图片和音频二进制直接塞进 SQLite

会带来数据库膨胀与维护问题。

### 14.2 不要让 TTS 阻塞文本主链路

否则聊天响应速度会明显变差。

### 14.3 不要直接拿中文做日语发音

应先生成 `speechTextJa`。

### 14.4 角色口癖与称呼要统一

建议在生成 `speechTextJa` 时沿用当前角色 Prompt 约束，避免中文和日语人格不一致。

### 14.5 名词读音要预留词典机制

尤其是：

- 角色名
- 地名
- 专有名词
- 口头禅

## 15. 最终推荐落地方案

如果以“尽快做出效果，同时不过度破坏现有架构”为目标，推荐采用以下组合：

### 首版组合

- 图片：文件落盘 + `metadata.attachments`
- 语音：助手消息后异步 TTS
- 中文显示：`content`
- 日语朗读：`speechTextJa`
- 前端展示：消息气泡下方原生音频播放器
- 通知机制：新增 `audio_ready` SSE 事件

### 长期组合

- 统一附件系统
- 独立 `tts-service`
- 角色音色配置化
- 增加发音词典
- 根据需要升级为 `contentParts` 多模态消息结构

## 16. 一句话结论

最合适的实现路线是：

“保留现有文本聊天主链路不动，把图片作为附件落盘存储，把角色语音作为助手消息的异步附加资源；界面显示中文，TTS 使用单独生成的日语朗读稿 `speechTextJa`。”
