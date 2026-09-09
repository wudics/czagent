# LLM 协议引擎与模型目录

> 对应 PLAN.md 决策 #4、#5、#6、#17。设计参考 `docs/ref/opencode-1.18.19-src/packages/llm/src/route/` 的事件模型与分层思想，落地为「模型为中心 + 每家独立引擎 + 统一网关」。
>
> **现状（2026-09 重构后，I 迭代 037）**：ChatProfile/BUILTIN_PROFILES 与 adapters 隐式路由已废弃。当前架构：
> - 模型配置持久化于 config.json 的 `chatModels`/`multimodalModels`（结构见 data-model.md §2.4），每条模型自带 implId/baseUrl/apiKey/modelName，自包含。
> - 每家接口实现（API 版本算新 provider）一个独立引擎文件，协议差异写死在实现内；解析/校验/路由唯一入口 `llm/gateway.ts`。
> - 新增 provider = 四步：`llm/engines/chat/` 新引擎文件 → `engines/index.ts` 注册 → `engines/catalog.ts` 元数据 → `provider.ts` 联合类型加字面量。

## 1. 能力（Capability）taxonomy

统一能力枚举，模型目录、绑定与工具系统共用：

```
chat                  # 对话（agent loop 主模型）
embedding             # 嵌入
rerank                # 重排
image-understanding   # 图像理解（vision 输入；模型放 multimodalModels，路由到 chat 引擎）
tts                   # 语音合成
asr                   # 语音识别
image-generation      # 图像生成
video-generation      # 视频生成
```

> `fim`/`video-understanding` 无实现，已从 Capability 移除；需要时随实现一并加回。

## 2. 分层结构

```
provider.ts          # 根类型：ChatImplId/MMImplId 联合、ChatModelConfig/MultimodalModelConfig、Settings
llm/gateway.ts       # ★ 唯一入口：解析（ResolvedChat 扁平视图）+ 校验（中文报错，不发未知请求）+ 按能力分发
llm/types.ts         # ChatBinding（baseUrl/apiKey/modelName）、ChatReq（纯业务字段）、ChatEngine/MMEngine 接口
llm/engines/
  ├── http.ts        # 共享原语：fetchJsonWithRetry（429/5xx 退避、retry-after）
  ├── openai-stream.ts # 共享原语：OpenAI 兼容请求体组装、SSE→LLMEvent（tool-call 聚合、usage 归一化、finish 断流）
  ├── mm.ts          # 多模态共享原语：postJson/下载转 dataUrl/输出提取/进度解析
  ├── catalog.ts     # 纯元数据（显示名/默认地址/适用能力；渲染层直引预填）
  ├── index.ts       # 注册表：implId → 引擎实例（与 catalog id 一一对应）
  ├── chat/*         # 每家一个独立对话引擎（差异写死在实现内）
  └── {video,image,embedding,rerank,audio}/*  # 多模态按能力各有针对性实现 + OpenAI 兼容兜底
```

- **网关解析视图**：`ResolvedChat = { modelId, displayName, binding, engine, vision, toolcall, maxOutput, contextLimit, options }`——chat 与 image-understanding 模型在此抹平差异。
- **options 合并**：模型配置级 options 与请求级 options 合并，调用方优先（修复旧体系 options 死字段问题）。

## 3. 统一事件模型 LLMEvent

所有能力、所有厂商最终产出这一组事件，agent loop / UI 只消费它：

```ts
type LLMEvent =
  | { type: 'text-delta'; text }
  | { type: 'reasoning-delta'; text }
  | { type: 'tool-call-start'; callID; tool } | { type: 'tool-call-delta'; callID; text }
  | { type: 'tool-call'; callID; tool; input }
  | { type: 'finish'; finishReason; usage? }
  | { type: 'error'; error: LLMError }
```

（`text/reasoning start/end`、`step-start/finish` 等由会话层在消费引擎事件时派生，引擎只报增量与终点。）

## 4. Chat 引擎（每家独立实现）

共享管道 `streamOpenAiChat(binding, req, opts)`：各引擎只声明自己的差异（`OpenAiChatOptions`）——

- `thinkingParams(mode)`：思考档位 → 追加到请求体的参数（写死在引擎文件内）
- `reasoningField`：流式 delta 思考字段名（默认 `reasoning_content`）
- `reasoningPassthrough`：是否强制回传历史 assistant 思考内容（DeepSeek 工具场景 400 规则）

### 4.1 引擎差异表

| 引擎 | baseURL 默认 | 思考参数 | 思维链字段 | 其他差异 |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `thinking:{type:enabled/disabled}` + `reasoning_effort:high`（deep 档） | `reasoning_content` | 带 tools 必须回传历史 reasoning（`reasoningPassthrough`） |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `enable_thinking` + `thinking_budget:8192`（deep 档） | `reasoning_content` | — |
| `agnes` | `https://apihub.agnes-ai.com/v1` | `chat_template_kwargs.enable_thinking` | `reasoning_content` | — |
| `bigmodel` | `https://open.bigmodel.cn/api/paas/v4` | `thinking:{type}` + `reasoning_effort:max`（deep 档） | `reasoning_content` | 标准 OpenAI SSE；默认 clear_thinking 清历史思考 |
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `enable_thinking` + `reasoning_effort:xhigh`（deep 档） | `reasoning_content` | qwen3.8 preserve_thinking 默认回传历史思考（`reasoningPassthrough`） |
| `openrouter` | `https://openrouter.ai/api/v1` | `reasoning:{effort}`（off=none / deep=max） | `reasoning`（统一格式） | 标准 OpenAI 兼容 + 平台扩展字段 |
| `openai-compatible`（兜底） | 用户自填 | 无（不发平台差异参数） | `reasoning_content` | 任意 OpenAI 兼容服务；不支持思考档位 |

> 思考档位映射（决策 15：off/on/deep）：`off` 尽量关闭思考，`on` 平台默认行为，`deep` 该平台最高推理档。个别模型（如 GLM-5.3 仅允许 enabled、qwen 非思考老模型不识别 enable_thinking）传参报 400 时，用户可切换 `openai-compatible` 兜底。

### 4.2 流式解析（SSE，共享）

- 帧：`data: {json}`，以 `data: [DONE]` 结束；`choices[0].delta.content/reasoning` 字段增量。
- 工具调用：`tool_calls[].index` 作流内 key，`id/name` 首个 delta 出现，参数按 delta 累积；finish_reason 到达统一 emit（空工具名或非法 JSON 参数降级为文本输出，缺 id 补 `call-N`）。
- finish 即断流并 cancel body（部分平台发完 finish 不关流）。
- usage：末尾 `usage` 块归一化（§7）。

### 4.3 重试 / 超时 / 错误分类

- 可重试状态：429 / 503 / 504 / 529；指数退避 + 尊重 `retry-after(-ms)`；最多 2 次（`engines/http.ts`）。
- 错误分类（`llm/errors.ts`）：401/403→Authentication；429→RateLimit/Quota；400/413/422→InvalidRequest（含 context-overflow 判定）；5xx→ProviderInternal。
- 网关前置校验：模型不存在 / Key 缺失 / implId 未注册 / 能力未绑定或模型被禁用 → 中文报错，不发请求。

## 5. 模型目录（决策 5 · 修订）

模型目录不再内置代码常量，**用户在设置页自建**（默认空，旧 `providers`/`models` 结构启动时检测重置）：

- **对话模型**（chatModels）：每条 = 接口实现（implId）+ 地址 + Key + 模型名 + 展示名 + 上下文/输出上限 + toolcall/vision 开关 + options；添加时按 implId 预填默认地址、复用同实现 Key。
- **多模态模型**（multimodalModels）：每条绑定一个 capability（embedding/rerank/image-generation/video-generation/tts/asr/image-understanding）+ implId + 地址/Key/模型名；image-understanding 路由到 chat 引擎。
- **能力绑定**（bindings）：8 个能力 → 模型 id；会话与工具经 Gateway 按绑定解析，未绑定中文报错。用户手动设置默认，添加模型不自动抢占绑定。

### 5.1 自定义厂商

接口实现下拉中的 `openai-compatible` 兜底任意 OpenAI 兼容服务（自填地址与 Key，无平台差异参数）；同名接口实现间添加模型自动复用 Key 与地址。

## 6. 自主选择模型（决策 6）

- **主对话模型**：会话设置的当前 chat 模型（每轮经 Gateway 重解析，失败回退创建时快照）。
- **能力工具**：embedding / rerank / image-generation / video-generation / tts / asr / image-understanding 经 Gateway 按能力绑定分发，工具参数可显式指定模型 id。

## 7. Usage 归一化与计费

统一口径：
```
inputTokens     = nonCached + cacheRead + cacheWrite
reasoningTokens ≤ outputTokens
```

- OpenAI 系：`prompt_tokens`（含 cached）→input；`prompt_tokens_details.cached_tokens`→cacheRead；`completion_tokens(_details.reasoning_tokens)`→output/reasoning；DeepSeek 的 `prompt_cache_hit_tokens` 同样映射 cacheRead。
- 计费：按模型 cost 配置分项累加 `session_usage`（逐轮落库，见 data-model.md §2.3）。

## 8. 多模态引擎（已实现）

| 能力 | 实现 | 要点 |
|---|---|---|
| video-generation | `agnes-video-v2.0`（旧格式 width/height/num_frames 8n+1≤441）、`agnes-video-2.5`（seconds/mode/size=720P；`probe.ts` 探测 mode 合法值并缓存）、`siliconflow-video`（异步 submit/status 轮询） | Agnes 自有查询协议 `GET /agnesapi?video_id=`；2.5 文档值失败自动回退旧值 |
| image-generation | `agnes-image`（size 档位 + 图生图 edit）、`openai-image`（精确像素） | Agnes 参数进 `extra_body`（response_format 必须进 extra_body，否则 400） |
| embedding / rerank / tts / asr | OpenAI 兼容实现 | `/embeddings`、`/rerank`、`/audio/speech`、`/audio/transcriptions` |
| image-understanding | 路由到 chat 引擎 | user 消息 `image_url` content 块（`buildOpenAiMessages` 组装） |

> 引擎接口为可选方法集合（`MMEngine`），网关调用前检查能力是否被该实现支持，不支持则显式报错并指引换绑。
