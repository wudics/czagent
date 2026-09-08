# LLM 协议引擎与模型目录

> 对应 PLAN.md 决策 #4、#5、#6、#17。依据 `docs/ref/大模型api接口文档/` 三家官方文档，设计参考 `docs/ref/opencode-1.18.19-src/packages/llm/src/route/` 的四轴分解。

## 1. 能力（Capability）taxonomy

统一能力枚举，模型目录与工具系统共用：

```
chat                  # 对话（agent loop 主模型）
embedding             # 嵌入
rerank                # 重排
image-understanding   # 图像理解（vision 输入）
video-understanding   # 视频理解
tts                   # 语音合成
asr                   # 语音识别
image-generation      # 图像生成
video-generation      # 视频生成
fim                   # 代码补全（前缀续写）
```

## 2. 四轴协议分解

```
Route = { protocol, endpoint, auth, framing, transport }

protocol  # "我说的是什么 API"：请求体构造(from) + 请求体 schema + 流事件 schema + 事件→LLMEvent 状态机
endpoint  # URL：{ baseURL, path, query }（path 可为函数）
auth      # 每请求鉴权：Auth.bearer(apiKey) / header / custom
framing   # 字节流→帧：Framing.sse（共享）
transport # HttpTransport.json（POST+SSE）
```

新厂商 = 组合一个 profile；协议 bug 一次修复全局生效（opencode 的设计精髓）。

## 3. 统一事件模型 LLMEvent

所有能力、所有厂商最终产出这一组事件，agent loop / UI 只消费它：

```ts
type LLMEvent =
  | { type: 'text-start' } | { type: 'text-delta'; text } | { type: 'text-end' }
  | { type: 'reasoning-start' } | { type: 'reasoning-delta'; text } | { type: 'reasoning-end' }
  | { type: 'tool-input-start'; callID; tool } | { type: 'tool-input-delta'; callID; text } | { type: 'tool-input-end'; callID }
  | { type: 'tool-call'; callID; tool; input; providerExecuted? }
  | { type: 'tool-result'; callID; result: { type:'success'|'error'; value } }
  | { type: 'step-start' } | { type: 'step-finish'; usage?: Usage } | { type: 'finish'; finishReason; usage }
  | { type: 'error'; error: LLMError }
```

## 4. Chat 协议（OpenAI 兼容 + profile 差异）

### 4.1 请求
- messages（system/user/assistant/tool）、tools（JSON Schema）、tool_choice、stream:true、stream_options.include_usage。
- **思考模式映射**（决策 15）：
  - DeepSeek：`thinking: { type: 'enabled'|'disabled' }`、`reasoning_effort`（low/high/max；medium/xhigh 映射到 high）
  - SiliconFlow：`enable_thinking`、`thinking_budget`（[128,32768]）、`reasoning_effort`（high/max）
  - Agnes（OpenAI 格式）：`chat_template_kwargs: { enable_thinking: true }`
  - 通用兜底：模型不支持时静默忽略

### 4.2 流式解析（SSE 状态机）
- 帧：`data: {json}`，以 `data: [DONE]` 结束（DeepSeek Responses 例外，无 [DONE]，以 `response.completed` 等语义事件结束）。
- 文本：`choices[0].delta.content`。
- 推理：`choices[0].delta.reasoning_content`（DeepSeek/SiliconFlow 风格）。
- **工具调用流式**：`tool_calls[].index` 作流内 key，`id`/`name` 只出现在首个 delta，JSON 参数按 delta 累积，finish_reason 到达时 `parseToolInput`（空串→`{}`，错误→报错）并发出 `tool-input-end` + `tool-call`。
- usage：末尾 `usage` 块归一化（见 §7）。

> 关键兼容点（DeepSeek）：携带 `tools` 的请求必须回传 `reasoning_content`（assistant 消息含 reasoning part 时），否则 400。协议层必须强制回传。

### 4.3 三家 profile 差异表

| 维度 | DeepSeek | SiliconFlow | Agnes |
|---|---|---|---|
| baseURL | `https://api.deepseek.com` | `https://api.siliconflow.cn/v1` | `https://apihub.agnes-ai.com/v1` |
| 鉴权 | Bearer | Bearer | Bearer |
| 模型 ID | 裸 ID（`deepseek-v4-pro`） | `org/Model`（`deepseek-ai/DeepSeek-V4-Flash`） | 裸 ID（`agnes-2.5-flash`） |
| 思考参数 | `thinking`+`reasoning_effort` | `enable_thinking`+`thinking_budget` | `chat_template_kwargs.enable_thinking` |
| 错误体 | 标准 OpenAI error | **可能为纯字符串**（"Invalid token"等），需双解析 | 标准 error 对象 + 自有错误码表 |
| 其他 | FIM `/beta/completions`、Responses `/responses`（无 [DONE]）、KV 缓存自动、`frequency_penalty`/`presence_penalty` deprecated | 默认 `temperature=0.7`、`frequency_penalty=0.5`（与 OpenAI 默认不同，需显式覆盖） | Responses 响应无顶层 `output_text`，需从 `output[]` 提取 |

### 4.4 重试 / 超时 / 错误分类 / 安全

- 可重试状态：429 / 503 / 504 / 529；指数退避 + 尊重服务端 `retry-after(-ms)`；最大重试 2 次。
- 超时：headerTimeout（默认 300s）+ SSE chunk 超时。
- 错误分类：401/403→Authentication；429→RateLimit/Quota；400/413/422→InvalidRequest（含 context-overflow 判定）；5xx→ProviderInternal；content_filter→ContentPolicy。
- 安全：请求/响应中的 `authorization|api_key|token|secret|signature` 全部脱敏（`<redacted>`），响应体截断 16KB。
- 上下文溢出正则库：`prompt is too long` / `context_length_exceeded` / `too many tokens` 等 → 触发压缩重跑（agent-loop.md §5）。

## 5. 模型目录（决策 5）

### 5.1 内置默认（P1 仅 chat，其余 P2）

按 API 文档提取三家常用模型作为内置默认，用户在设置页可增改/禁用：

| 平台 | 内置默认 chat 模型 |
|---|---|
| DeepSeek | `deepseek-v4-pro`（1M/384K）、`deepseek-v4-flash`（1M/384K） |
| SiliconFlow | `deepseek-ai/DeepSeek-V4-Flash`、`Qwen/Qwen3-*`（按 /models 文档子集） |
| Agnes | `agnes-2.5-flash`（512K/65.5K）、`agnes-2.5-pro`（1M/65.5K） |

P2 扩充：SiliconFlow 的 embedding（`BAAI/bge-m3`、`Qwen/Qwen3-Embedding-*`）、rerank（`Qwen/Qwen3-Reranker-*`）、图像（`Kwai-Kolors/Kolors`、`Qwen/Qwen-Image-Edit-2509`）、视频（`Wan-AI/Wan2.2-*`）、语音（TTS/ASR）；Agnes 的 `agnes-image-*`、`agnes-video-*`。

### 5.2 目录结构

```ts
interface ModelDef {
  id: string;            // 平台内模型 ID
  provider: ProviderId;  // deepseek | siliconflow | agnes | openai-compatible
  capability: Capability;// 默认 chat
  name: string;          // 展示名
  limit: { context: number; maxOutput: number };
  options?: Record<string, unknown>;  // 平台默认参数覆盖（如 siliconflow temperature）
  enabled: boolean;
  isDefault?: boolean;   // 内置 vs 用户覆盖
}
```

合并规则：内置默认（代码内常量） → 用户覆盖（sqlite `model_configs`，决策 3）→ 最终模型列表。无网络依赖、离线可用。

### 5.3 自定义厂商（openai-compatible）

设置页支持新增任意 OpenAI 兼容厂商：`{ provider: 'openai-compatible', baseURL, apiKey, models: [...] }`，复用同一 chat 协议（无特殊 profile 时走最通用实现）。

## 6. 自主选择模型（决策 6）

- **主对话模型**：会话设置的当前 chat 模型。
- **能力工具**：embedding / rerank / image-generation / video-generation / tts / asr / image-understanding 各暴露为工具，工具默认绑定已配置的对应能力模型实例，**工具参数可显式指定模型 id**（如 `image_generate({ model: 'agnes-image-2.1-flash', prompt })`）。
- 机制：模型目录按 `capability` 过滤出可选实例，注入工具 schema 的 `enum`；agent 自主决策用哪个实例（P1 落地），子代理路由（`task` 工具按任务委派模型）P2。

## 7. Usage 归一化与计费

统一口径（参考 `packages/llm/src/schema/events.ts`）：
```
inputTokens     = nonCached + cacheRead + cacheWrite   # 含缓存总口径
reasoningTokens ≤ outputTokens
visibleOutput   = outputTokens - reasoningTokens
```

- DeepSeek：`prompt_tokens`（含 cached）→input；`prompt_cache_hit_tokens`→cacheRead；`completion_tokens`→output；`completion_tokens_details.reasoning_tokens`→reasoning。
- SiliconFlow：同 OpenAI 结构（`prompt_tokens_details.cached_tokens`）。
- Agnes：`prompt_tokens`/`completion_tokens`/`total_tokens`。
- 计费：按模型 cost 配置分项（input/output/cache-read/cache-write/reasoning）累加 `session_usage`。

## 8. 多模态与任务型协议（P2 实现规划）

| 能力 | 实现要点 |
|---|---|
| embedding | `POST /embeddings`（SiliconFlow，支持图片输入），`encoding_format`、`dimensions` |
| rerank | `POST /rerank`：`query`+`documents`+`top_n`，返回 relevance_score |
| image-generation | SiliconFlow `POST /images/generations`（响应 `images[].url`）；Agnes 同端点但响应 `data[].url`、参数需放 `extra_body`（`response_format` 必须进 extra_body，否则 400） |
| video-generation | SiliconFlow 异步 `/video/submit` + `/video/status` 轮询；Agnes 创建 `/videos` + **自有查询协议** `GET /agnesapi?video_id=` |
| tts / asr | SiliconFlow `/audio/speech`、`/audio/transcriptions`；音色模型 `fnlp/MOSS-TTSD-v0.5` |
| image-understanding | 走 chat 协议 user 消息 `image_url` part（三家文本模型均支持图片输入） |

> 注意：以上差异必须落在 profile 层，协议引擎对上层保持"能力一致"接口（如 `video.submit/status` 统一封装异步任务抽象）。
