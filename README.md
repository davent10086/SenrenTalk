# SenrenTalk

基于 LangGraph 的多角色 AI 角色扮演对话应用，支持单聊、多角色群聊，具备三层记忆体系、流式对话体验、多媒体附件与日语 TTS 语音合成。

> 应用代码在 [my-rp-chat-app/](my-rp-chat-app/) 下，角色配置与构建脚本在 `索引数据/` 和 `脚本/` 中。

---

## 特性亮点

- **多角色群聊**: 多 Agent 协调机制，支持 @mention 定向发言和动态发言顺序，分阶段提示自然收尾
- **三层记忆系统**: L1 工作记忆 → L2 情景记忆 → L3 核心记忆，自动提炼长期信息
- **流式对话**: SSE 实时推送，Token 级增量渲染，支持多客户端连接与 Backlog 回放
- **RAG 检索**: 三路混合检索（向量 + BM25 + 标签匹配），RRF 融合排序
- **角色扮演**: 结构化提示词注入，包含禁用词、自称呼、语气、关系设定等配置，内置提示注入防护
- **多媒体附件**: 支持图片、音频、文件附件上传与展示（MIME 白名单 + 大小限制）
- **日语 TTS**: 可选集成 OpenAI 兼容 API / Qwen CosyVoice 语音合成，支持角色音色映射
- **后台任务管理**: JobRegistry 统一管理聊天任务与索引构建任务，支持并发控制

## 技术栈

| 层      | 技术                             | 版本             |
| -------- | --------------------------------- | ---------------- |
| 运行时  | Node.js                           | >=22             |
| 语言     | TypeScript                        | ES2022 / strict  |
| 前端     | React 18 + Vite 8 + Framer Motion | React 18.2       |
| UI 图标  | Lucide React                      | latest           |
| 后端     | Express 5                         | 5.2.1            |
| AI 编排  | LangChain + LangGraph             | 1.1.48 / 1.3.6   |
| LLM      | DeepSeek（通过 OpenAI 兼容 API）   | deepseek-chat    |
| 向量检索 | Elasticsearch 9 + bge-m3          | 9.4.2            |
| 数据库   | SQLite (better-sqlite3, WAL 模式)  | 12.10.0          |
| 流式推送 | Server-Sent Events (SSE)          | 独立 HTTP 服务器 |
| 文件上传 | Multer                            | 2.x              |
| TTS      | OpenAI 兼容 / Qwen CosyVoice      | 可选            |
| 可观测性 | LangSmith                         | 可选            |
| 测试     | Vitest + Testing Library          | 4.x              |

## 项目结构

```
SenrenTalk/
├── my-rp-chat-app/           # 应用代码（主入口）
│   ├── src/
│   │   ├── common/types.ts            # 全部共享类型定义（消息、角色、记忆、流事件、附件等）
│   │   ├── server/
│   │   │   ├── index.ts               # Express 入口，路由注册
│   │   │   ├── api-service.ts         # API 服务层，所有业务逻辑入口
│   │   │   ├── config-check.ts        # 启动时配置校验
│   │   │   └── middleware/
│   │   │       ├── cors.ts            # CORS（仅允许 127.0.0.1/localhost）
│   │   │       └── security.ts        # 速率限制 + 文件上传校验 + 全局错误处理
│   │   ├── backend/
│   │   │   ├── config.ts              # AppConfig 配置解析
│   │   │   ├── app-runtime.ts         # AppRuntime：依赖注入容器 + 消息发送入口
│   │   │   ├── worker-runtime.ts      # WorkerRuntime：Electron Worker 模式的 API 入口
│   │   │   ├── job-registry.ts        # JobRegistry：后台任务注册中心
│   │   │   ├── media-manager.ts       # 媒体资源管理器
│   │   │   ├── db/database.ts         # SQLite 仓库，6 张表，5 个索引
│   │   │   ├── graph/
│   │   │   │   ├── chat-graphs.ts     # 单聊 LangGraph 图（7 节点）
│   │   │   │   └── group-coordinator.ts # 群聊多 Agent 协调器
│   │   │   └── services/
│   │   │       ├── characters/character-service.ts
│   │   │       ├── llm/deepseek-service.ts
│   │   │       ├── memory/memory-service.ts
│   │   │       ├── stream/sse-service.ts
│   │   │       ├── tts/tts-service.ts
│   │   │       └── es/
│   │   │           ├── elasticsearch-service.ts
│   │   │           └── bge-m3-embedding-service.ts
│   │   └── renderer/
│   │       ├── main.tsx               # 前端入口
│   │       ├── App.tsx                # 根组件
│   │       ├── api/client.ts          # API 客户端
│   │       ├── hooks/useChatStream.ts # SSE 流式消费 Hook
│   │       ├── utils/avatar.ts        # 头像路径解析
│   │       ├── components/            # 聊天组件（ChatWorkspace, MessageList, MessageBubble 等）
│   │       ├── pages/                 # 页面（CharacterList, SingleChat, GroupChat, Settings）
│   │       └── context/               # Context 状态管理（Bootstrap, View, Chat）
│   ├── scripts/
│   │   └── build-dialogue-index.ts    # 对话索引构建脚本
│   ├── tests/                         # Vitest 测试（含 helpers/factories/mock）
│   ├── benchmark/                     # 性能基准测试
│   ├── patches/                       # Native 补丁（better-sqlite3）
│   ├── public/                        # 角色头像等静态资源
│   └── docs/                          # 设计文档（TTS 方案等）
├── 索引数据/                          # 角色配置、对话数据、ES 索引配置
├── 脚本/                              # 数据构建工具（ES 上传等）
├── cover.png                          # 仓库封面
└── LICENSE                            # MIT License
```

## 架构总览

```
  Browser (React 18 + Vite 8, port 5173)
        │
        │ HTTP (POST /api/chats/:chatId/send)
        ▼
  Express 5 Server (port 3001)
        │
        ▼  ApiService → AppRuntime / WorkerRuntime
        │                  │
        │  ▸ HTTP 模式     │  ▸ Electron Worker 模式
        │                  │
        ├── 单聊: createSingleChatGraph().invoke()
        │          └── 7 节点 LangGraph 流水线
        └── 群聊: GroupChatCoordinator.runSession()
                    └── 每个角色独立调用 createSingleChatGraph
        │
        ▼  SSE 独立服务器 (127.0.0.1, 随机端口)
        │
        │ EventSource (UUID 鉴权)
        ▼
  useChatStream Hook → MessageBubble 实时渲染
                        ├── 文本增量更新
                        ├── 图片附件缩略图
                        └── AudioPlayer 语音播放
```

### 双运行时模式

项目支持两种部署模式，通过同一套 `ApiService` 提供业务能力：

| 运行时         | 入口文件            | 适用场景               | 通信方式   |
| ------------- | ------------------- | ---------------------- | ---------- |
| **AppRuntime** | `app-runtime.ts`    | 独立 HTTP 服务器模式   | REST API   |
| **WorkerRuntime** | `worker-runtime.ts` | Electron 主进程 Worker | IPC 调用   |

## Agent 调用链路（单聊）

单聊使用 LangGraph 的 `StateGraph`，定义 7 个节点，通过条件边实现验证重试。

### 节点序列

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

### 条件边

```
validate_response 后
  state.validationIssue && state.retryCount < 1
    → build_prompt (重试生成)
    → save_message (保存)
```

## 群聊多 Agent 协调

`GroupChatCoordinator` 管理多个 `createSingleChatGraph` 实例，每个角色独立执行完整的 7 节点流水线。

### 调用流程

```
runSession()
  ├── 初始化: 为每个参与者惰性创建 agent 图实例
  ├── Turn 0: @mention 定向发言
  │  仅被 @ 的角色回答，其他角色收到 "保持沉默" 指令
  │  generatedCount++, turnCount++
  └── 后续轮次循环 (while generatedCount < maxMessages)
      ├── 退出条件检查
      │  turnCount >= maxRounds (默认 3) → break
      │  idleStreak >= idleStreakThreshold (默认 2) → break
      ├── 确定发言人 resolveNextSpeaker()
      │  优先使用 agent 指定的 nextSpeaker
      │  无指定 → firstUnspoken() (按参与顺序)
      ├── runAgentTurn(roleId, sharedHistory, ...)
      │  formatGroupContext() → 构建群聊提示词
      │  agent.invoke(state) → 执行完整 7 节点流水线
      │  返回 { messages, nextSpeaker }
      ├── generatedCount++, unspoken.delete(roleId)
      └── 轮次推进与 Idle 检测
```

### 分阶段提示策略

- **前 2 轮**: 提示 agent 可以使用 `nextSpeaker` 指定下一位发言者
- **第 3 轮起**: 提示 "群聊已进入尾声，请完成本轮对话后主动停止发言"

### 退出条件

| 条件                  | 默认值 | 说明                                 |
| --------------------- | ------ | ------------------------------------ |
| `maxMessages`         | 15     | 最大生成消息数                       |
| `maxRounds`           | 3      | 最大轮次（每轮至少一轮所有角色发言） |
| `idleStreakThreshold` | 2      | 连续 N 轮无人主动指定 nextSpeaker    |

## 记忆系统

三层记忆架构，从短期到长期逐步抽象：

| 层级 | 名称     | 存储                        | 触发                              | 内容                                     |
| ---- | -------- | --------------------------- | --------------------------------- | ---------------------------------------- |
| L1   | 工作记忆 | SQLite `memory_summaries`   | 每次 extractAndPersist 后自动更新 | 最近 6 条消息的摘要                      |
| L2   | 情景记忆 | SQLite `memory_events` + ES | 每个 agent 发言后异步提取         | 摘要、情绪、重要度(0-10)、关键点、标签  |
| L3   | 核心记忆 | SQLite `core_memories` + ES | 每积累 5 条 L2 记忆后整合         | 用户偏好、特质、关系阶段、笔记、关键事实 |

## 数据库 Schema

6 张表，使用 SQLite WAL 模式 + 外键约束。

| 表名               | 用途      | 关键列                                                                              |
| ------------------ | --------- | ---------------------------------------------------------------------------------- |
| `characters`       | 角色配置   | id, name, display_name, is_playable, character_type, summary, prompt_profile_json  |
| `chats`            | 会话记录   | id, title, mode, participants_json, mention_target, created_at, updated_at         |
| `messages`         | 消息      | id, chat_id (FK), role, role_id, content, timestamp, metadata_json                |
| `memory_events`    | 情景记忆   | id, chat_id (FK), session_id, character, content, category, timestamp, tags_json   |
| `core_memories`    | 核心记忆   | id, chat_id (FK), character_id, user_preferences_json, user_traits_json, relationship_stage, key_facts_json |
| `memory_summaries` | 对话摘要   | id, chat_id (UNIQUE), summary, created_at                                          |

## 多媒体附件

支持三种附件类型，通过 Multer 处理上传：

| 类型   | MIME 示例                    | 限制           | 展示方式             |
| ------ | ---------------------------- | -------------- | -------------------- |
| 图片   | image/png, image/jpeg        | 单文件 5MB   | MessageBubble 缩略图 |
| 音频   | audio/mpeg, audio/wav        | 单文件 5MB   | 播放控件展示         |
| 文件   | application/pdf 等           | 单文件 5MB     | 文件名 + 大小展示    |

安全限制：总数上限（每次最多 6 个）+ MIME 白名单 + security.ts 中间件统一拦截

## SSE 流式服务

- 独立 HTTP 服务器，绑定 127.0.0.1，随机端口
- UUID 鉴权：streamId + token（Bearer 或 query 参数）
- 多客户端连接：同一 streamId 可多个 EventSource 同时连接
- Backlog 回放：新客户端连接时自动回放历史事件

### SSE 事件类型

| 事件类型       | 方向          | 时机              | 负载                                       |
| -------------- | ------------- | ----------------- | ------------------------------------------ |
| status         | 服务端→客户端 | 节点开始执行      | { roleId, message }                        |
| token          | 服务端→客户端 | LLM 逐 token 输出 | { roleId, token }                          |
| message_done   | 服务端→客户端 | 消息保存完成      | { roleId, messageId, content, metadata }   |
| audio_ready    | 服务端→客户端 | TTS 合成完成      | { roleId, messageId, relativePath }        |
| error          | 服务端→客户端 | 执行出错          | { roleId?, message }                       |

## 检索系统

### hybridSearch（三路混合检索）

1. **dense_vector**: cosineSimilarity，基于 bge-m3 (1024 维)
2. **BM25**: multi_match on text / text_norm / all_tags 字段
3. **Tag matching**: 标签精确匹配（scene / emotion / function / tone）

RRF 融合排序: score = 1 / (60 + rank + 1)，按总分降序取 top-K。

## 安全措施

| 措施         | 实现                                           |
| ------------ | ---------------------------------------------- |
| SQL 注入防护 | better-sqlite3 参数化查询                      |
| 认证         | SSE 唯 UUID token 鉴权                         |
| CORS         | 仅允许 127.0.0.1 / localhost / null origin     |
| 速率限制     | 每分钟 60 次                                    |
| 文件上传     | MIME 白名单 + 大小限制 (5MB) + 数量限制 (6 个) |
| 全局错误处理 | 5xx 不暴露内部错误信息                         |
| 提示注入防护 | system prompt 中标记不可信参考领域              |
| API Key      | 仅从环境变量读取，不记录日志                    |

## 开发

### 前置要求

- **Node.js**: >=22
- **DeepSeek API Key**: 必须在 .env 中配置
- **Elasticsearch 9** (可选): 用于向量检索，不配置则仅使用 SQLite 全文搜索
- **Ollama** (可选): 用于本地 Embedding (bge-m3)

### 快速开始

```bash
# 安装依赖
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

### 环境变量说明

| 变量                   | 必填 | 说明                                                |
| ---------------------- | ---- | --------------------------------------------------- |
| DEEPSEEK_API_KEY       | 是   | DeepSeek API 密钥                                   |
| DEEPSEEK_BASE_URL      | 否   | 默认为 https://api.deepseek.com                      |
| DEEPSEEK_MODEL         | 否   | 默认为 deepseek-chat                                |
| ES_NODE                | 否   | ES 地址，不填则禁用 ES                              |
| ES_PASSWORD            | 否   | ES 密码                                             |
| OLLAMA_HOST            | 否   | 默认为 http://127.0.0.1:11434                        |
| OLLAMA_MODEL_NAME      | 否   | 默认为 bge-m3:latest                                |
| TTS_PROVIDER           | 否   | disabled / openai-compatible / qwen-cosyvoice       |
| LANGSMITH_TRACING      | 否   | 设为 true 启用 LangSmith 追踪                        |

## 常见问题

**Q: 启动后无法发送消息？**
检查 .env 中 DEEPSEEK_API_KEY 是否正确配置，且网络可以访问 DeepSeek API。

**Q: RAG 检索返回空结果？**
确保已执行 npm run index:dialogues 构建索引。

**Q: 群聊无限循环不结束？**
默认最大 3 轮（maxRounds=3），连续 2 轮无指定发言者（idleStreakThreshold=2）也会退出。

**Q: TTS 语音不播放？**
确认 TTS_PROVIDER 已正确配置且对应服务可用。

**Q: 附件上传失败？**
确认文件大小不超过 5MB，MIME 类型在白名单内，单次不超过 6 个文件。

## License

[MIT](./LICENSE)
