# Create a Chat Completion

> 接口文档来源：https://api-docs.siliconflow.cn/docs/api/chat-completions-post

## 接口信息

- **方法**: POST
- **路径**: `/v1/chat/completions`
- **认证**: `Authorization: Bearer {API_KEY}`
- **Content-Type**: `application/json`
- **兼容性**: OpenAI Chat Completions 格式

## 概述

为给定的对话创建模型响应，支持流式输出、工具调用、JSON 输出等功能。

## 请求参数（Body）

### 核心参数（LLM）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，如 `deepseek-ai/DeepSeek-V4-Flash`。完整列表见 [Models](https://cloud.siliconflow.cn/models?types=chat) |
| `messages` | array | ✅ | 对话消息列表 |
| `stream` | boolean | ❌ | 是否流式输出（SSE），以 `data: [DONE]` 结尾 |
| `max_tokens` | integer | ❌ | 最大生成 token 数（不含思维链）。建议不要设为窗口上限，预留约 10k tokens 缓冲 |
| `enable_thinking` | boolean | ❌ | 思考/非思考模式切换（适用于多数推理模型） |
| `thinking_budget` | integer | ❌ | 思维链输出最大 token 数，范围 [128, 32768] |
| `reasoning_effort` | string | ❌ | 推理强度：`high` / `max`（适用于 DeepSeek-V4 系列、GLM-5.2）。默认 high，复杂 agent 请求自动为 max |
| `min_p` | number | ❌ | 动态过滤阈值（仅 Qwen3），≤ 1 |
| `stop` | string\|array | ❌ | 停止序列，最多 4 个 |
| `temperature` | number | ❌ | 随机性控制，≤ 2，默认 0.7 |
| `top_p` | number | ❌ | 核采样，≤ 1，默认 0.7 |
| `top_k` | number | ❌ | ≤ 100，默认 50 |
| `frequency_penalty` | number | ❌ | 频率惩罚 [-2, 2]，默认 0.5 |
| `n` | integer | ❌ | 生成数量，默认 1 |
| `response_format` | object | ❌ | 输出格式：text / json_schema / json_object |
| `tools` | array | ❌ | 工具列表（仅支持 function），最多 128 个 |
| `tool_choice` | string | ❌ | `none` / `auto` / `required` 或指定工具 |

### messages 消息结构

支持 `system` / `user` / `assistant` / `tool` 角色。VLM 模型的 user 消息 content 支持文本与图片混合：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Describe this image"},
    {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
  ]
}
```

### response_format 三种格式

**Text（默认）**：
```json
{"type": "text"}
```

**JSON Schema（推荐）**：
```json
{
  "type": "json_schema",
  "json_schema": { "...": "JSON Schema 定义" }
}
```

**JSON Object（旧版 JSON 模式）**：
```json
{"type": "json_object"}
```

> 注意：使用 `json_object` 时，必须在 system 或 user 消息中指示模型生成 JSON。

### tools 结构

```json
{
  "type": "function",
  "function": {
    "name": "get_current_weather",
    "description": "Get the current weather in a given location",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {"type": "string", "description": "The city and state, e.g. San Francisco, CA"},
        "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
      },
      "required": ["location"]
    }
  }
}
```

## 响应格式（200 OK）

```json
{
  "id": "019bdaa55225ef854b320e9b838f77ce",
  "object": "chat.completion",
  "created": 1768899826,
  "model": "deepseek-ai/DeepSeek-V4-Flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！...",
        "reasoning_content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 1540,
    "total_tokens": 1555,
    "completion_tokens_details": {"reasoning_tokens": 1190},
    "prompt_tokens_details": {"cached_tokens": 0},
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 15
  },
  "system_fingerprint": ""
}
```

### 响应字段说明

| 字段 | 说明 |
|------|------|
| `object` | 恒为 `chat.completion` |
| `choices[].message.reasoning_content` | 思维链内容（推理模型） |
| `choices[].finish_reason` | 停止原因：`stop` / `length` 等 |
| `usage.completion_tokens_details.reasoning_tokens` | 思维链 token 数 |
| `usage.prompt_cache_hit_tokens` | 缓存命中的输入 token 数 |

## 调用示例

### cURL

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello, please introduce yourself."}
    ]
  }'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://api.siliconflow.cn/v1"
)

response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V4-Flash",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello, please introduce yourself."}
    ]
)
print(response.choices[0].message.content)
```

### 流式 + 工具调用

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://api.siliconflow.cn/v1"
)

tools = [
  {
    "type": "function",
    "function": {
      "name": "get_current_weather",
      "description": "Get the current weather in a given location",
      "parameters": {
        "type": "object",
        "properties": {
          "location": {"type": "string", "description": "The city and state, e.g. San Francisco, CA"},
          "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
        },
        "required": ["location"]
      }
    }
  }
]

messages = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is the weather like in Boston today?"},
    {"role": "assistant", "content": "Boston is sunny today, 20°C."},
    {"role": "user", "content": "What about New York?"}
]

stream = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V4-Flash",
    messages=messages,
    tools=tools,
    tool_choice="auto",
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta
    if delta.content:
        print(delta.content, end="", flush=True)
    if delta.tool_calls:
        print(delta.tool_calls)
```

## 错误响应示例

| 状态码 | 示例响应 |
|--------|----------|
| 400 | `{"code": 20012, "message": "string", "data": "string"}` |
| 401 | `"Invalid token"` |
| 403 | `"Forbidden"` |
| 404 | `"404 page not found"` |
| 429 | `{"message": "Request was rejected due to rate limiting...", "data": "string"}` |
| 503 | `{"code": 50505, "message": "Model service overloaded. Please try again later.", "data": "string"}` |
| 504 | `"string"` |
