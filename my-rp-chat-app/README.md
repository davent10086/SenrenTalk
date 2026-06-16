# SenrenTalk

基于 LangGraph 的多角色 AI 对话应用，支持单聊、多角色群聊、角色扮演，具备三层记忆体系与流式对话体验。

## 特性亮点

- **多角色群聊**: 多 Agent 协调机制，支持 @mention 定向发言和动态发言顺序
- **三层记忆系统**: L1 工作记忆 → L2 情景记忆 → L3 核心记忆，自动提炼长期信息
- **流式对话**: SSE 实时推送，Token 级增量渲染
- **RAG 检索**: 三路混合检索（向量 + BM25 + 标签匹配），RRF 融合排序
- **角色扮演**: 结构化提示词注入，包含禁用词、自称呼、语气等配置
- **日语 TTS**: 可选集成 OpenAI 兼容 API / Qwen CosyVoice 语音合成

## 技术栈

| 层       | 技术                              | 版本             |
| -------- | --------------------------------- | ---------------- |
| 运行时   | Node.js                           | >=22             |
| 语言     | TypeScript                        | ES2022 / strict  |
| 前端     | React 18 + Vite 8 + Framer Motion | React 18.2       |
| 后端     | Express 5                         | 5.2.1            |
| AI 编排  | LangChain + LangGraph             | 1.1.48 / 1.3.6   |
| LLM      | DeepSeek（通过 OpenAI 兼容 API）  | deepseek-chat    |
| 向量检索 | Elasticsearch 9 + bge-m3          | 9.4.2            |
| 数据库   | SQLite (better-sqlite3, WAL 模式) | 12.10.0          |
| 流式推送 | Server-Sent Events (SSE)          | 独立 HTTP 服务器 |
| TTS      | OpenAI 兼容 / Qwen CosyVoice      | 可选             |
| 可观测性 | LangSmith                         | 可选             |

## 项目结构

```
my-rp-chat-app/
├── src/
│   ├── common/types.ts              # 全部共享类型定义
│   ├── server/
│   │   ├── index.ts                 # Express 入口，路由注册
│   │   └── middleware/
│   │       ├── cors.ts              # CORS（仅允许 127.0.0.1/localhost）
│   │       └── security.ts          # 速率限制 + 文件上传校验 + 全局错误处理
│   ├── backend/
│   │   ├── config.ts                # AppConfig 配置解析
│   │   ├── app-runtime.ts           # AppRuntime：依赖注入容器 + 消息发送入口
│   │   ├── db/database.ts           # SQLite 仓库（5 张表，15 个索引）
│   │   ├── graph/
│   │   │   ├── chat-graphs.ts       # 单聊 LangGraph 图（7 节点）
│   │   │   └── group-coordinator.ts # 群聊多 Agent 协调器
│   │   └── services/
│   │       ├── characters/          # 角色配置加载
│   │       ├── llm/                 # DeepSeek LLM 服务
│   │       ├── memory/              # 三层记忆系统
│   │       ├── stream/              # SSE 流式服务
│   │       ├── tts/                 # TTS 语音合成
│   │       └── es/                  # Elasticsearch 服务
│   └── renderer/
│       ├── App.tsx                  # 前端入口 + Provider 层级
│       ├── api/client.ts            # API 客户端
│       ├── hooks/useChatStream.ts   # SSE 流式消费 Hook
│       ├── components/ChatWorkspace.tsx  # 聊天工作区
│       ├── pages/
│       │   ├── CharacterListPage.tsx    # 角色列表
│       │   ├── SingleChatPage.tsx       # 单聊页面
│       │   ├── GroupChatCreatePage.tsx  # 群聊创建
│       │   ├── GroupChatPage.tsx        # 群聊页面
│       │   └── SettingsPage.tsx         # 系统设置
│       └── context/
│           ├── BootstrapContext.tsx  # 角色/会话初始化
│           ├── ViewContext.tsx       # 视图路由 + 聊天CRUD
│           └── ChatContext.tsx       # 消息状态管理
├── tests/                           # Vitest 测试
├── 索引数据/                        # 角色配置、对话数据、ES 索引配置
└── benchmark/                       # 性能基准测试
```

## 架构总览

```
  Browser / Electron (React 18 + Vite 8, port 5173)
        │
        │ HTTP (POST /api/chats/:chatId/send)
        ▼
  Express 5 Server (port 3001)
        │
        ▼
  ApiService → AppRuntime
        │
        ├── 单聊: createSingleChatGraph().invoke()
        │        └── 7 节点 LangGraph 流水线
        │
        └── 群聊: GroupChatCoordinator.runSession()
                 └── 每个角色独立调用 createSingleChatGraph
        │
        ▼
  SSE 独立服务器 (127.0.0.1, 随机端口)
        │
        │ EventSource (token 鉴权)
        ▼
  useChatStream Hook → ChatWorkspace 实时渲染
```

## Agent 调用链路（单聊）

单聊使用 LangGraph 的 `StateGraph`，定义 7 个节点，通过条件边实现验证重试。

### 节点序列

```
START
  │
  ▼
[1] prepare_turn
  │  确定当前发言角色 → 从数据库加载 CharacterProfile
  │  重置输出缓冲区 (output, speechTextJa, validationIssue)
  │  SSE 推送: status "正在准备角色数据..."
  │
  ▼
[2] retrieve_context
  │  构造检索查询 buildRetrievalQuery()
  │  → 群聊模式: 拼接最近 6 条群聊消息作为查询上下文
  │  → ElasticsearchService.hybridSearch() (topK=6, 按 character 过滤)
  │  三路混合检索: dense_vector + BM25 + tag matching
  │  RRF 融合排序
  │
  ▼
[3] retrieve_memory
  │  L1: getSummary() → 对话摘要
  │  L2: memoryService.recall() → ES/SQLite 情景记忆
  │  L3: getCoreMemory() → 核心记忆 (relationshipStage + keyFacts 前 3 项)
  │
  ▼
[4] build_prompt
  │  buildSystemPrompt() 构建角色扮演提示词:
  │  ├── 身份、性格、自称、语气
  │  ├── 禁用词、禁用风格
  │  ├── 世界知识、关系设定
  │  ├── 提示注入防护规则（"不可信参考"区域）
  │  └── 群聊模式: 附加 groupContext
  │
  ▼
[5] call_llm_stream
  │  deepSeekService.streamStructuredCompletion()
  │  ├── temperature: 0.7
  │  ├── JSON 结构化输出: { content, speechTextJa, nextSpeaker? }
  │  ├── 流式增量提取 content 字段 → SSE token 推送
  │  └── 流结束后完整解析 JSON → 返回 content / speechTextJa / nextSpeaker
  │
  ▼
[6] validate_response
  │  检查: 是否包含 forbiddenWords / 是否缺少 selfAddress
  │  ├── 有问题 && retryCount < 1 → 回到 [4] build_prompt (重试 1 次)
  │  └── 通过 → 继续
  │
  ▼
[7] save_message
  │  构建 ChatMessageMetadata (检索/记忆计数 + speechTextJa)
  │  repository.appendMessage() → 写入 SQLite
  │  SSE 推送: message_done
  │  scheduleAssistantAudio() → fire-and-forget TTS 合成
  │
  ▼
 END
```

### 条件边

```
validate_response 后:
  state.validationIssue && state.retryCount < 1
    → build_prompt (重试生成)
    → save_message (保存)
```

### 图状态 (ChatState) 字段

| 字段              | 类型                            | 说明             |
| ----------------- | ------------------------------- | ---------------- |
| `chatId`          | `string`                        | 会话 ID          |
| `streamId`        | `string`                        | SSE 流 ID        |
| `mode`            | `"single" \| "group"`           | 模式             |
| `participants`    | `string[]`                      | 参与者列表       |
| `mentionTarget`   | `string \| null`                | @mention 目标    |
| `activeRoleIndex` | `number`                        | 当前发言角色索引 |
| `currentRoleId`   | `string \| undefined`           | 当前发言角色 ID  |
| `messages`        | `ChatMessage[]`                 | 完整消息历史     |
| `retrievedDocs`   | `RetrievedDoc[]`                | ES 检索结果      |
| `memories`        | `RetrievedDoc[]`                | 记忆检索结果     |
| `summary`         | `string \| undefined`           | L1 对话摘要      |
| `prompt`          | `string`                        | 系统提示词       |
| `output`          | `string`                        | LLM 输出         |
| `speechTextJa`    | `string`                        | 日语朗读稿       |
| `retryCount`      | `number`                        | 重试次数         |
| `validationIssue` | `string \| undefined`           | 验证问题         |
| `character`       | `CharacterProfile \| undefined` | 角色信息         |
| `nextSpeaker`     | `string \| undefined`           | 下一位发言者     |
| `coreMemory`      | `string \| undefined`           | 核心记忆         |
| `groupContext`    | `string \| undefined`           | 群聊上下文       |

## 群聊多 Agent 协调

`GroupChatCoordinator` 管理多个 `createSingleChatGraph` 实例，每个角色独立执行完整的 7 节点流水线。

### 调用流程

```
runSession()
  │
  ├── 初始化: 为每个参与者懒创建 agent 图实例
  │
  ├── Turn 0: @mention 定向发言
  │   │  仅被 @ 的角色回复
  │   │  其他角色收到 "保持沉默" 指令
  │   │  generatedCount++, turnCount++
  │
  └── 后续轮次循环 (while generatedCount < maxMessages)
      │
      ├── 退出条件检查:
      │   ├── turnCount >= maxRounds (默认 3) → break
      │   └── idleStreak >= idleStreakThreshold (默认 2) → break
      │
      ├── unspoken 重置: 所有角色发言完毕 → 重置 unspoken 集合
      │
      ├── 确定发言者: resolveNextSpeaker()
      │   ├── 优先使用 agent 指定的 nextSpeaker
      │   │   ├── 有效的参与者且未发言 → 使用
      │   │   └── 无效/已发言 → 回退到轮询顺序
      │   └── 无指定 → firstUnspoken() (按参与顺序)
      │
      ├── runAgentTurn(roleId, sharedHistory, ...)
      │   │  formatGroupContext() → 构造群聊提示词
      │   │  agent.invoke(state) → 执行完整 7 节点流水线
      │   │  返回 { messages, nextSpeaker }
      │   │
      │   ├── sharedHistory = 更新后的消息列表
      │   ├── generatedCount++
      │   ├── unspoken.delete(roleId)
      │   └── nextSpeaker = agent 指定的下一位发言者
      │
      ├── Idle 检测:
      │   ├── nextSpeaker 存在 → idleStreak = 0 (链式发言中)
      │   └── nextSpeaker 不存在 → idleStreak++
      │
      └── 轮次推进:
          ├── unspoken 为空 (一轮结束) → turnCount++
          └── nextSpeaker 存在 → turnCount++ (链式跳转)
  │
  └── Fire-and-forget: processMemories()
      └── 对每个参与者:
          ├── extractAndPersist() → L2 情景记忆提取
          └── consolidateCoreMemory() → L3 核心记忆整合
```

### 群聊上下文 (formatGroupContext)

```
=== 群聊模式 ===
群聊参与者：丛雨、芳乃、茉子
你的名字是 丛雨。
这是第 1 轮对话。
你可以自由选择回应对象。
如果你想对某个特定角色说话，请在 JSON 回复中添加 "nextSpeaker" 字段，
指定你希望接下来发言的角色名。可选值：芳乃、茉子。
如果不需要指定，就不要加这个字段。
注意：群聊不宜过长，2~3 轮后应主动停止指定 nextSpeaker，让对话自然收尾。

=== 最近的群聊消息 ===
用户：你们好呀
(前 8 条消息)
```

### 退出条件

| 条件                  | 默认值 | 说明                                 |
| --------------------- | ------ | ------------------------------------ |
| `maxMessages`         | 15     | 最大生成消息数                       |
| `maxRounds`           | 3      | 最大轮次（每轮至少一轮所有角色发言） |
| `idleStreakThreshold` | 2      | 连续 N 轮无人主动指定 nextSpeaker    |

### 前 2 轮 + 第 3 轮起的分阶段提示

- **前 2 轮**: 提示 agent 可以使用 `nextSpeaker` 指定下一位发言者
- **第 3 轮起**: 提示 "群聊已进入尾声，请完成本轮对话后主动停止发言，不要在 JSON 中添加 nextSpeaker 字段"

## 记忆系统

三层记忆架构，从短期到长期逐步抽象：

| 层级 | 名称     | 存储                        | 触发                              | 内容                                     |
| ---- | -------- | --------------------------- | --------------------------------- | ---------------------------------------- |
| L1   | 工作记忆 | SQLite `memory_summaries`   | 每次 extractAndPersist 后自动更新 | 最近 6 条消息的摘要                      |
| L2   | 情景记忆 | SQLite `memory_events` + ES | 每个 agent 发言后异步提取         | 摘要、情绪、重要度、关键点               |
| L3   | 核心记忆 | SQLite `core_memories` + ES | 每积累 5 条 L2 记忆后整合         | 用户偏好、特质、关系阶段、笔记、关键事实 |

### 记忆提取流程

```
LLM 调用 (extractEpisodicMemory)
  │  temperature: 0.3
  │  输入: 最近一条 user + assistant 消息
  │  输出: 摘要、情绪、重要度 (0-10)、关键点列表
  │
  ▼
MemoryEvent → SQLite + ES 双写
  │
  ▼
自动更新 L1 摘要 (updateSummary)
  │
  ▼
每 5 条 L2 记忆 → consolidateCoreMemory (LLM)
  │  temperature: 0.3
  │  输入: 最近 5 条 L2 记忆 + 现有核心记忆
  │  输出: 用户偏好、特质、关系阶段、关键事实
  │
  ▼
CoreMemory → SQLite + ES 双写
```

## 数据库 Schema

5 张表，使用 SQLite WAL 模式 + 外键约束。

| 表名               | 用途     | 关键列                                                                                                                                             |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `characters`       | 角色配置 | id, name, display_name, is_playable, character_type, summary, prompt_profile_json                                                                  |
| `chats`            | 会话记录 | id, title, mode, participants_json, mention_target, created_at, updated_at                                                                         |
| `messages`         | 消息     | id, chat_id (FK), role, role_id, content, timestamp, metadata_json                                                                                 |
| `memory_events`    | 情景记忆 | id, chat_id (FK), session_id, character, content, category, timestamp, tags_json, source_message_id                                                |
| `core_memories`    | 核心记忆 | id, chat_id (FK), character_id, user_preferences_json, user_traits_json, relationship_stage, relationship_notes_json, key_facts_json, last_updated |
| `memory_summaries` | 对话摘要 | id, chat_id (UNIQUE), summary, created_at                                                                                                          |

索引: `idx_messages_chat_id`, `idx_memory_events_chat_id_session`, `idx_core_memories_chat_id`, `idx_memory_summaries_chat_id`

## SSE 流式服务

- 独立 HTTP 服务器，绑定 `127.0.0.1`，随机端口
- 双 UUID 鉴权：`streamId` + `token`（Bearer 或 query 参数）
- 多客户端连接：同一 `streamId` 可多个 EventSource 同时连接
- Backlog 回放：新客户端连接时自动回放历史事件
- CORS 复用：仅允许 `127.0.0.1` / `localhost` / `null` (file://)

### SSE 事件类型

| 事件类型       | 方向          | 时机              | 负载                                       |
| -------------- | ------------- | ----------------- | ------------------------------------------ |
| `status`       | 服务端→客户端 | 节点开始执行      | `{ roleId, message }`                      |
| `token`        | 服务端→客户端 | LLM 逐 token 输出 | `{ roleId, token }`                        |
| `message_done` | 服务端→客户端 | 消息保存完成      | `{ roleId, messageId, content, metadata }` |
| `audio_ready`  | 服务端→客户端 | TTS 合成完成      | `{ roleId, messageId, relativePath }`      |
| `audio_failed` | 服务端→客户端 | TTS 合成失败      | `{ roleId, messageId }`                    |
| `error`        | 服务端→客户端 | 执行出错          | `{ roleId?, message }`                     |

## 检索系统

### hybridSearch (三路混合检索)

1. **dense_vector**: cosineSimilarity，基于 bge-m3 (1024 维)
2. **BM25**: multi_match on text / text_norm / all_tags 字段
3. **Tag matching**: 标签匹配

RRF 融合排序: `score = 1 / (60 + rank + 1)`，按总分降序取 top-K。

### searchMemories (两路混合检索)

- dense_vector + BM25 (fields: content / tags / category)
- RRF 融合

## 安全措施

| 措施         | 实现                                           |
| ------------ | ---------------------------------------------- |
| SQL 注入防护 | better-sqlite3 参数化查询 (prepare + run)      |
| 认证         | SSE 双 UUID token 鉴权                         |
| CORS         | 仅允许 127.0.0.1 / localhost / null origin     |
| 速率限制     | 每分钟 60 次 (内存 Map)                        |
| 文件上传     | MIME 白名单 + 大小限制 (5MB) + 数量限制 (6 个) |
| 全局错误处理 | 5xx 不暴露内部错误信息                         |
| 提示注入防护 | system prompt 中标记"不可信参考"区域           |
| API Key      | 仅从环境变量读取，不记录日志                   |

## 开发

### 前置要求

- **Node.js**: >=22
- **DeepSeek API Key**: 必须在 `.env` 中配置
- **Elasticsearch 9** (可选): 用于向量检索，如不配置则仅使用 SQLite 全文搜索
- **Ollama** (可选): 用于本地 Embedding，如不配置则使用远程服务

### 快速开始

```bash
# 克隆后安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 DEEPSEEK_API_KEY 等必填项

# 构建对话索引（首次运行前必须执行）
npm run index:dialogues

# 并行启动前后端（开发模式）
npm run dev

# 仅启动后端
npm run dev:server

# 仅启动前端
npm run dev:client
```

访问 http://localhost:5173 进入应用。

### 其他命令

```bash
# 类型检查
npm run typecheck

# ESLint 检查
npm run lint

# 运行测试
npm test

# 运行测试（监听模式）
npm run test:watch

# 构建生产版本
npm run build

# 性能基准测试
npm run benchmark
```

### 环境变量说明

| 变量                   | 必填 | 说明                                                |
| ---------------------- | ---- | --------------------------------------------------- |
| `DEEPSEEK_API_KEY`     | 是   | DeepSeek API 密钥                                   |
| `DEEPSEEK_BASE_URL`    | 否   | 默认为 `https://api.deepseek.com`                   |
| `DEEPSEEK_MODEL`       | 否   | 默认为 `deepseek-chat`                              |
| `ES_NODE`              | 否   | Elasticsearch 地址，不填则禁用 ES                   |
| `ES_PASSWORD`          | 否   | ES 密码                                             |
| `OLLAMA_HOST`          | 否   | 默认为 `http://127.0.0.1:11434`                     |
| `OLLAMA_MODEL_NAME`    | 否   | 默认为 `bge-m3:latest`                              |
| `EMBEDDING_DIMENSIONS` | 否   | 默认为 `1024`                                       |
| `DATASET_DIR`          | 否   | 角色数据目录，默认为 `../索引数据`                  |
| `TTS_PROVIDER`         | 否   | `disabled` / `openai-compatible` / `qwen-cosyvoice` |
| `LANGSMITH_TRACING`    | 否   | 设为 `true` 启用 LangSmith 追踪                     |

## 常见问题

**Q: 启动后无法发送消息？**  
检查 `.env` 中 `DEEPSEEK_API_KEY` 是否正确配置，且网络可以访问 DeepSeek API。

**Q: RAG 检索返回空结果？**  
确保已执行 `npm run index:dialogues` 构建索引，且 Elasticsearch 服务正常运行。

**Q: 群聊无限循环不结束？**  
群聊默认最多 3 轮（`maxRounds=3`），连续 2 轮无 Agent 指定下一发言者（`idleStreakThreshold=2`）也会退出。

**Q: TTS 语音不播放？**  
确认 `.env` 中 `TTS_PROVIDER` 已配置为 `openai-compatible` 或 `qwen-cosyvoice`，且对应服务可用。

## License

Private
