# SenrenTalk

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-ES2022-3178C6?logo=typescript" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js" alt="Node.js"/>
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="License"/>
  <img src="https://img.shields.io/badge/LangGraph-1.3.6-FF6F00" alt="LangGraph"/>
  <img src="https://img.shields.io/badge/React-18.2-61DAFB?logo=react" alt="React"/>
  <img src="https://img.shields.io/badge/Elasticsearch-9-005571?logo=elasticsearch" alt="Elasticsearch"/>
</p>

鍩轰簬 **LangGraph** 鐨勫瑙掕壊 AI 瑙掕壊鎵紨瀵硅瘽搴旂敤锛屾敮鎸佸崟鑱娿€佸瑙掕壊缇よ亰锛屽叿澶囦笁灞傝蹇嗕綋绯汇€佹祦寮忓璇濅綋楠屻€佸濯掍綋闄勪欢涓庢棩璇?TTS 璇煶鍚堟垚銆?
> 搴旂敤浠ｇ爜鍦?[my-rp-chat-app/](my-rp-chat-app/) 涓嬶紝瑙掕壊閰嶇疆涓庢瀯寤鸿剼鏈湪 `绱㈠紩鏁版嵁/` 鍜?`鑴氭湰/` 涓€?
---

## 鐩綍

- [杩愯鎴浘](#杩愯鎴浘)
- [鐗规€т寒鐐筣(#鐗规€т寒鐐?
- [鎶€鏈爤](#鎶€鏈爤)
- [蹇€熷紑濮媇(#蹇€熷紑濮?
- [椤圭洰缁撴瀯](#椤圭洰缁撴瀯)
- [鏋舵瀯鎬昏](#鏋舵瀯鎬昏)
- [鏁版嵁搴揮(#鏁版嵁搴?
- [瀹夊叏鎺柦](#瀹夊叏鎺柦)
- [甯歌闂](#甯歌闂)
- [License](#license)

---

## 杩愯鎴浘

| 瑙掕壊閫夋嫨 | 涓汉瀵硅瘽 | 缇よ亰鍦烘櫙 |
| :---: | :---: | :---: |
| ![瑙掕壊鍒楄〃](my-rp-chat-app/public/杩愯鎴浘/瑙掕壊鍒楄〃.png) | ![涓汉鑱婂ぉ](my-rp-chat-app/public/杩愯鎴浘/涓汉鑱婂ぉ.png) | ![缇よ亰鎴浘](my-rp-chat-app/public/杩愯鎴浘/缇よ亰鎴浘.png) |

---

## 鐗规€т寒鐐?
- **澶氳鑹茬兢鑱?*: 澶?Agent 鍗忚皟鏈哄埗锛屾敮鎸?@mention 瀹氬悜鍙戣█鍜屽姩鎬佸彂瑷€椤哄簭锛屽垎闃舵鎻愮ず鑷劧鏀跺熬
- **涓夊眰璁板繂绯荤粺**: L1 宸ヤ綔璁板繂 鈫?L2 鎯呮櫙璁板繂 鈫?L3 鏍稿績璁板繂锛岃嚜鍔ㄦ彁鐐奸暱鏈熶俊鎭?- **娴佸紡瀵硅瘽**: SSE 瀹炴椂鎺ㄩ€侊紝Token 绾у閲忔覆鏌擄紝鏀寔澶氬鎴风杩炴帴涓?Backlog 鍥炴斁
- **RAG 妫€绱?*: 涓夎矾娣峰悎妫€绱紙鍚戦噺 + BM25 + 鏍囩鍖归厤锛夛紝RRF 铻嶅悎鎺掑簭
- **瑙掕壊鎵紨**: 缁撴瀯鍖栨彁绀鸿瘝娉ㄥ叆锛屽寘鍚鐢ㄨ瘝銆佽嚜绉板懠銆佽姘斻€佸叧绯昏瀹氱瓑閰嶇疆锛屽唴缃彁绀烘敞鍏ラ槻鎶?- **澶氬獟浣撻檮浠?*: 鏀寔鍥剧墖銆侀煶棰戙€佹枃浠堕檮浠朵笂浼犱笌灞曠ず锛圡IME 鐧藉悕鍗?+ 澶у皬闄愬埗锛?- **鏃ヨ TTS**: 鍙€夐泦鎴?OpenAI 鍏煎 API / Qwen CosyVoice 璇煶鍚堟垚锛屾敮鎸佽鑹查煶鑹叉槧灏?- **鍚庡彴浠诲姟绠＄悊**: JobRegistry 缁熶竴绠＄悊鑱婂ぉ浠诲姟涓庣储寮曟瀯寤轰换鍔★紝鏀寔骞跺彂鎺у埗

## 鎶€鏈爤

| 灞?| 鎶€鏈?| 鐗堟湰 |
| --- | --- | --- |
| 杩愯鏃?| Node.js | >=22 |
| 璇█ | TypeScript | ES2022 / strict |
| 鍓嶇 | React 18 + Vite 8 + Framer Motion | React 18.2 |
| UI 鍥炬爣 | Lucide React | latest |
| 鍚庣 | Express 5 | 5.2.1 |
| AI 缂栨帓 | LangChain + LangGraph | 1.1.48 / 1.3.6 |
| LLM | DeepSeek锛堥€氳繃 OpenAI 鍏煎 API锛?| deepseek-chat |
| 鍚戦噺妫€绱?| Elasticsearch 9 + bge-m3 | 9.4.2 |
| 鏁版嵁搴?| SQLite (better-sqlite3, WAL 妯″紡) | 12.10.0 |
| 娴佸紡鎺ㄩ€?| Server-Sent Events (SSE) | 鐙珛 HTTP 鏈嶅姟鍣?|
| 鏂囦欢涓婁紶 | Multer | 2.x |
| TTS | OpenAI 鍏煎 / Qwen CosyVoice | 鍙€?|
| 鍙娴嬫€?| LangSmith | 鍙€?|
| 娴嬭瘯 | Vitest + Testing Library | 4.x |

## 蹇€熷紑濮?
### 鍓嶇疆瑕佹眰

- **Node.js**: >=22
- **DeepSeek API Key**: 蹇呴』鍦?.env 涓厤缃?- **Elasticsearch 9** (鍙€?: 鐢ㄤ簬鍚戦噺妫€绱紝涓嶉厤缃垯浠呬娇鐢?SQLite 鍏ㄦ枃鎼滅储
- **Ollama** (鍙€?: 鐢ㄤ簬鏈湴 Embedding (bge-m3)

### 蹇€熷紑濮?
```bash
# 瀹夎渚濊禆
npm install

# 閰嶇疆鐜鍙橀噺
cp .env.example .env
# 缂栬緫 .env 濉叆 DEEPSEEK_API_KEY 绛夊繀濉」

# 鏋勫缓瀵硅瘽绱㈠紩锛堥娆¤繍琛屽墠蹇呴』鎵ц锛?npm run index:dialogues

# 骞惰鍚姩鍓嶅悗绔紙寮€鍙戞ā寮忥級
npm run dev

# 浠呭惎鍔ㄥ悗绔?npm run dev:server

# 浠呭惎鍔ㄥ墠绔?npm run dev:client
```

璁块棶 http://localhost:5173 杩涘叆搴旂敤銆?
### 鐜鍙橀噺璇存槑

| 鍙橀噺 | 蹇呭～ | 璇存槑 |
| --- | --- | --- |
| DEEPSEEK_API_KEY | 鏄?| DeepSeek API 瀵嗛挜 |
| DEEPSEEK_BASE_URL | 鍚?| 榛樿涓?https://api.deepseek.com |
| DEEPSEEK_MODEL | 鍚?| 榛樿涓?deepseek-chat |
| ES_NODE | 鍚?| ES 鍦板潃锛屼笉濉垯绂佺敤 ES |
| ES_PASSWORD | 鍚?| ES 瀵嗙爜 |
| OLLAMA_HOST | 鍚?| 榛樿涓?http://127.0.0.1:11434 |
| OLLAMA_MODEL_NAME | 鍚?| 榛樿涓?bge-m3:latest |
| TTS_PROVIDER | 鍚?| disabled / openai-compatible / qwen-cosyvoice |
| LANGSMITH_TRACING | 鍚?| 璁句负 true 鍚敤 LangSmith 杩借釜 |

## 椤圭洰缁撴瀯

```
SenrenTalk/
鈹溾攢鈹€ my-rp-chat-app/           # 搴旂敤浠ｇ爜锛堜富鍏ュ彛锛?鈹?  鈹溾攢鈹€ src/
鈹?  鈹?  鈹溾攢鈹€ common/types.ts            # 鍏ㄩ儴鍏变韩绫诲瀷瀹氫箟锛堟秷鎭€佽鑹层€佽蹇嗐€佹祦浜嬩欢銆侀檮浠剁瓑锛?鈹?  鈹?  鈹溾攢鈹€ server/
鈹?  鈹?  鈹?  鈹溾攢鈹€ index.ts               # Express 鍏ュ彛锛岃矾鐢辨敞鍐?鈹?  鈹?  鈹?  鈹溾攢鈹€ api-service.ts         # API 鏈嶅姟灞傦紝鎵€鏈変笟鍔￠€昏緫鍏ュ彛
鈹?  鈹?  鈹?  鈹溾攢鈹€ config-check.ts        # 鍚姩鏃堕厤缃牎楠?鈹?  鈹?  鈹?  鈹斺攢鈹€ middleware/
鈹?  鈹?  鈹?      鈹溾攢鈹€ cors.ts            # CORS锛堜粎鍏佽 127.0.0.1/localhost锛?鈹?  鈹?  鈹?      鈹斺攢鈹€ security.ts        # 閫熺巼闄愬埗 + 鏂囦欢涓婁紶鏍￠獙 + 鍏ㄥ眬閿欒澶勭悊
鈹?  鈹?  鈹溾攢鈹€ backend/
鈹?  鈹?  鈹?  鈹溾攢鈹€ config.ts              # AppConfig 閰嶇疆瑙ｆ瀽
鈹?  鈹?  鈹?  鈹溾攢鈹€ app-runtime.ts         # AppRuntime锛氫緷璧栨敞鍏ュ鍣?+ 娑堟伅鍙戦€佸叆鍙?鈹?  鈹?  鈹?  鈹溾攢鈹€ worker-runtime.ts      # WorkerRuntime锛欵lectron Worker 妯″紡鐨?API 鍏ュ彛
鈹?  鈹?  鈹?  鈹溾攢鈹€ job-registry.ts        # JobRegistry锛氬悗鍙颁换鍔℃敞鍐屼腑蹇?鈹?  鈹?  鈹?  鈹溾攢鈹€ media-manager.ts       # 濯掍綋璧勬簮绠＄悊鍣?鈹?  鈹?  鈹?  鈹溾攢鈹€ db/database.ts         # SQLite 浠撳簱锛? 寮犺〃锛? 涓储寮?鈹?  鈹?  鈹?  鈹溾攢鈹€ graph/
鈹?  鈹?  鈹?  鈹?  鈹溾攢鈹€ chat-graphs.ts     # 鍗曡亰 LangGraph 鍥撅紙7 鑺傜偣锛?鈹?  鈹?  鈹?  鈹?  鈹斺攢鈹€ group-coordinator.ts # 缇よ亰澶?Agent 鍗忚皟鍣?鈹?  鈹?  鈹?  鈹斺攢鈹€ services/
鈹?  鈹?  鈹?      鈹溾攢鈹€ characters/character-service.ts
鈹?  鈹?  鈹?      鈹溾攢鈹€ llm/deepseek-service.ts
鈹?  鈹?  鈹?      鈹溾攢鈹€ memory/memory-service.ts
鈹?  鈹?  鈹?      鈹溾攢鈹€ stream/sse-service.ts
鈹?  鈹?  鈹?      鈹溾攢鈹€ tts/tts-service.ts
鈹?  鈹?  鈹?      鈹斺攢鈹€ es/
鈹?  鈹?  鈹?          鈹溾攢鈹€ elasticsearch-service.ts
鈹?  鈹?  鈹?          鈹斺攢鈹€ bge-m3-embedding-service.ts
鈹?  鈹?  鈹斺攢鈹€ renderer/
鈹?  鈹?      鈹溾攢鈹€ main.tsx               # 鍓嶇鍏ュ彛
鈹?  鈹?      鈹溾攢鈹€ App.tsx                # 鏍圭粍浠?鈹?  鈹?      鈹溾攢鈹€ api/client.ts          # API 瀹㈡埛绔?鈹?  鈹?      鈹溾攢鈹€ hooks/useChatStream.ts # SSE 娴佸紡娑堣垂 Hook
鈹?  鈹?      鈹溾攢鈹€ utils/avatar.ts        # 澶村儚璺緞瑙ｆ瀽
鈹?  鈹?      鈹溾攢鈹€ components/            # 鑱婂ぉ缁勪欢
鈹?  鈹?      鈹溾攢鈹€ pages/                 # 椤甸潰
鈹?  鈹?      鈹斺攢鈹€ context/               # Context 鐘舵€佺鐞?鈹?  鈹溾攢鈹€ scripts/
鈹?  鈹?  鈹斺攢鈹€ build-dialogue-index.ts    # 瀵硅瘽绱㈠紩鏋勫缓鑴氭湰
鈹?  鈹溾攢鈹€ tests/                         # Vitest 娴嬭瘯
鈹?  鈹溾攢鈹€ benchmark/                     # 鎬ц兘鍩哄噯娴嬭瘯
鈹?  鈹溾攢鈹€ patches/                       # Native 琛ヤ竵锛坆etter-sqlite3锛?鈹?  鈹溾攢鈹€ public/                        # 瑙掕壊澶村儚绛夐潤鎬佽祫婧?鈹?  鈹斺攢鈹€ docs/                          # 璁捐鏂囨。锛圱TS 鏂规绛夛級
鈹溾攢鈹€ 绱㈠紩鏁版嵁/                          # 瑙掕壊閰嶇疆銆佸璇濇暟鎹€丒S 绱㈠紩閰嶇疆
鈹溾攢鈹€ 鑴氭湰/                              # 鏁版嵁鏋勫缓宸ュ叿锛圗S 涓婁紶绛夛級
鈹溾攢鈹€ docs/                              # 鏋舵瀯璁捐鏂囨。
鈹?  鈹溾攢鈹€ agent-call-chain.md            # Agent 璋冪敤閾捐矾璇﹁В
鈹?  鈹斺攢鈹€ group-chat-coordination.md     # 缇よ亰鍗忚皟鏈哄埗璇﹁В
鈹溾攢鈹€ cover.png                          # 浠撳簱灏侀潰
鈹斺攢鈹€ LICENSE                            # MIT License
```

## 鏋舵瀯鎬昏

### 鍙岃繍琛屾椂妯″紡

椤圭洰鏀寔涓ょ閮ㄧ讲妯″紡锛岄€氳繃鍚屼竴濂?`ApiService` 鎻愪緵涓氬姟鑳藉姏锛?
| 杩愯鏃?| 鍏ュ彛鏂囦欢 | 閫傜敤鍦烘櫙 | 閫氫俊鏂瑰紡 |
| --- | --- | --- | --- |
| **AppRuntime** | `app-runtime.ts` | 鐙珛 HTTP 鏈嶅姟鍣ㄦā寮?| REST API |
| **WorkerRuntime** | `worker-runtime.ts` | Electron 涓昏繘绋?Worker | IPC 璋冪敤 |

```
  Browser (React 18 + Vite 8, port 5173)
        鈹?        鈹?HTTP (POST /api/chats/:chatId/send)
        鈻?  Express 5 Server (port 3001)
        鈹?        鈻? ApiService 鈫?AppRuntime / WorkerRuntime
        鈹?        鈹溾攢鈹€ 鍗曡亰: createSingleChatGraph().invoke()
        鈹?         鈹斺攢鈹€ 7 鑺傜偣 LangGraph 娴佹按绾?        鈹?             锛堣瑙佷笅鏂规灦鏋勬枃妗ｏ級
        鈹斺攢鈹€ 缇よ亰: GroupChatCoordinator.runSession()
                    鈹斺攢鈹€ 姣忎釜瑙掕壊鐙珛璋冪敤鍗曡亰娴佹按绾?        鈹?        鈻? SSE 鐙珛鏈嶅姟鍣?(127.0.0.1, 闅忔満绔彛)
        鈹?        鈹?EventSource (UUID 閴存潈)
        鈻?  useChatStream Hook 鈫?MessageBubble 瀹炴椂娓叉煋
                        鈹溾攢鈹€ 鏂囨湰澧為噺鏇存柊
                        鈹溾攢鈹€ 鍥剧墖闄勪欢缂╃暐鍥?                        鈹斺攢鈹€ AudioPlayer 璇煶鎾斁
```

### Agent 璋冪敤閾捐矾锛堝崟鑱婏級

鍗曡亰鍩轰簬 LangGraph 鐨?`StateGraph`锛屽畾涔変簡 **7 涓妭鐐?* 鐨勬祦姘寸嚎锛岄€氳繃鏉′欢杈瑰疄鐜伴獙璇侀噸璇曘€?
```
START 鈫?[1] prepare_turn 鈫?[2] retrieve_context 鈫?[3] retrieve_memory
       鈫?[4] build_prompt 鈫?[5] call_llm_stream 鈫?[6] validate_response
       鈫?[7] save_message 鈫?END
         鈫?       鈹?         鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?(楠岃瘉澶辫触鏃堕噸璇?build_prompt)
```

> 鍚勮妭鐐圭殑璇︾粏瀹炵幇涓庢暟鎹祦璇存槑瑙?[Agent 璋冪敤閾捐矾璇﹁В](docs/agent-call-chain.md)

### 缇よ亰澶?Agent 鍗忚皟

`GroupChatCoordinator` 绠＄悊澶氫釜 `createSingleChatGraph` 瀹炰緥锛屾瘡涓鑹茬嫭绔嬫墽琛屽畬鏁寸殑 7 鑺傜偣娴佹按绾裤€傛敮鎸?@mention 瀹氬悜鍙戣█銆佽嚜鍔ㄩ€€鍑烘娴嬩笌鍒嗛樁娈垫彁绀虹瓥鐣ャ€?
> 鍗忚皟鍣ㄧ殑璋冪敤娴佺▼銆侀€€鍑烘潯浠朵笌鎻愮ず绛栫暐瑙?[缇よ亰鍗忚皟鏈哄埗璇﹁В](docs/group-chat-coordination.md)

### 涓夊眰璁板繂绯荤粺

| 灞傜骇 | 鍚嶇О | 瀛樺偍 | 瑙﹀彂 | 鍐呭 |
| --- | --- | --- | --- | --- |
| L1 | 宸ヤ綔璁板繂 | SQLite `memory_summaries` | 姣忔 extractAndPersist 鍚庤嚜鍔ㄦ洿鏂?| 鏈€杩?6 鏉℃秷鎭殑鎽樿 |
| L2 | 鎯呮櫙璁板繂 | SQLite `memory_events` + ES | 姣忎釜 agent 鍙戣█鍚庡紓姝ユ彁鍙?| 鎽樿銆佹儏缁€侀噸瑕佸害(0-10)銆佸叧閿偣銆佹爣绛?|
| L3 | 鏍稿績璁板繂 | SQLite `core_memories` + ES | 姣忕Н绱?5 鏉?L2 璁板繂鍚庢暣鍚?| 鐢ㄦ埛鍋忓ソ銆佺壒璐ㄣ€佸叧绯婚樁娈点€佺瑪璁般€佸叧閿簨瀹?|

### SSE 娴佸紡鏈嶅姟

鐙珛 HTTP 鏈嶅姟鍣紝缁戝畾 127.0.0.1 闅忔満绔彛锛孶UID 閴存潈锛屾敮鎸佸瀹㈡埛绔繛鎺ヤ笌 Backlog 鍥炴斁銆?
| 浜嬩欢绫诲瀷 | 鏂瑰悜 | 鏃舵満 | 璐熻浇 |
| --- | --- | --- | --- |
| status | 鏈嶅姟绔啋瀹㈡埛绔?| 鑺傜偣寮€濮嬫墽琛?| { roleId, message } |
| token | 鏈嶅姟绔啋瀹㈡埛绔?| LLM 閫?token 杈撳嚭 | { roleId, token } |
| message_done | 鏈嶅姟绔啋瀹㈡埛绔?| 娑堟伅淇濆瓨瀹屾垚 | { roleId, messageId, content, metadata } |
| audio_ready | 鏈嶅姟绔啋瀹㈡埛绔?| TTS 鍚堟垚瀹屾垚 | { roleId, messageId, relativePath } |
| error | 鏈嶅姟绔啋瀹㈡埛绔?| 鎵ц鍑洪敊 | { roleId?, message } |

## 鏁版嵁搴?
6 寮犺〃锛屼娇鐢?SQLite WAL 妯″紡 + 澶栭敭绾︽潫銆?
| 琛ㄥ悕 | 鐢ㄩ€?| 鍏抽敭鍒?|
| --- | --- | --- |
| `characters` | 瑙掕壊閰嶇疆 | id, name, display_name, is_playable, character_type, summary, prompt_profile_json |
| `chats` | 浼氳瘽璁板綍 | id, title, mode, participants_json, mention_target, created_at, updated_at |
| `messages` | 娑堟伅 | id, chat_id (FK), role, role_id, content, timestamp, metadata_json |
| `memory_events` | 鎯呮櫙璁板繂 | id, chat_id (FK), session_id, character, content, category, timestamp, tags_json |
| `core_memories` | 鏍稿績璁板繂 | id, chat_id (FK), character_id, user_preferences_json, user_traits_json, relationship_stage, key_facts_json |
| `memory_summaries` | 瀵硅瘽鎽樿 | id, chat_id (UNIQUE), summary, created_at |

## 瀹夊叏鎺柦

| 鎺柦 | 瀹炵幇 |
| --- | --- |
| SQL 娉ㄥ叆闃叉姢 | better-sqlite3 鍙傛暟鍖栨煡璇?|
| 璁よ瘉 | SSE 鍞?UUID token 閴存潈 |
| CORS | 浠呭厑璁?127.0.0.1 / localhost / null origin |
| 閫熺巼闄愬埗 | 姣忓垎閽?60 娆?|
| 鏂囦欢涓婁紶 | MIME 鐧藉悕鍗?+ 澶у皬闄愬埗 (5MB) + 鏁伴噺闄愬埗 (6 涓? |
| 鍏ㄥ眬閿欒澶勭悊 | 5xx 涓嶆毚闇插唴閮ㄩ敊璇俊鎭?|
| 鎻愮ず娉ㄥ叆闃叉姢 | system prompt 涓爣璁颁笉鍙俊鍙傝€冮鍩?|
| API Key | 浠呬粠鐜鍙橀噺璇诲彇锛屼笉璁板綍鏃ュ織 |

## 甯歌闂

**Q: 鍚姩鍚庢棤娉曞彂閫佹秷鎭紵**
妫€鏌?.env 涓?DEEPSEEK_API_KEY 鏄惁姝ｇ‘閰嶇疆锛屼笖缃戠粶鍙互璁块棶 DeepSeek API銆?
**Q: RAG 妫€绱㈣繑鍥炵┖缁撴灉锛?*
纭繚宸叉墽琛?npm run index:dialogues 鏋勫缓绱㈠紩銆?
**Q: 缇よ亰鏃犻檺寰幆涓嶇粨鏉燂紵**
榛樿鏈€澶?3 杞紙maxRounds=3锛夛紝杩炵画 2 杞棤鎸囧畾鍙戣█鑰咃紙idleStreakThreshold=2锛変篃浼氶€€鍑恒€?
**Q: TTS 璇煶涓嶆挱鏀撅紵**
纭 TTS_PROVIDER 宸叉纭厤缃笖瀵瑰簲鏈嶅姟鍙敤銆?
**Q: 闄勪欢涓婁紶澶辫触锛?*
纭鏂囦欢澶у皬涓嶈秴杩?5MB锛孧IME 绫诲瀷鍦ㄧ櫧鍚嶅崟鍐咃紝鍗曟涓嶈秴杩?6 涓枃浠躲€?
## License

[MIT](./LICENSE)
