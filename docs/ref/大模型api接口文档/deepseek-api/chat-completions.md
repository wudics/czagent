# Chat Completions API

> 接口文档来源：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion

## 接口信息

- **方法**: POST
- **路径**: `/chat/completions`
- **认证**: `Authorization: Bearer ${DEEPSEEK_API_KEY}`
- **Content-Type**: `application/json`

## 概述

根据输入的上下文，让模型补全对话内容。这是 DeepSeek 最核心的对话补全接口，兼容 OpenAI Chat Completions 格式。

## 请求参数（Body）

### 核心参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型 ID：`deepseek-v4-flash` / `deepseek-v4-pro` |
| `messages` | array | ✅ | 对话消息列表（≥1 条） |
| `thinking` | object | ❌ | 思考模式控制，`{"type": "enabled"}` 或 `{"type": "disabled"}`，默认 `enabled` |
| `reasoning_effort` | string | ❌ | 推理强度：`low` / `high` / `max`，默认 `high`（`medium`/`xhigh` 映射为 `high`） |
| `max_tokens` | integer | ❌ | 最大生成 token 数（受上下文长度限制） |
| `response_format` | object | ❌ | 输出格式：`{"type": "json_object"}` 启用 JSON 模式 |
| `stop` | string\|array | ❌ | 停止序列，最多 16 个 string |
| `stream` | boolean | ❌ | 是否流式输出（SSE），默认 `false` |
| `stream_options` | object | ❌ | 流式选项，`stream=true` 时可用 |
| `temperature` | number | ❌ | 采样温度 [0, 2]，默认 1 |
| `top_p` | number | ❌ | 核采样 [0, 1]，默认 1 |
| `tools` | array | ❌ | 工具列表，目前仅支持 function，最多 128 个 |
| `tool_choice` | object\|string | ❌ | `none` / `auto` / `required` 或指定 `{"type": "function", "function": {"name": "..."}}` |
| `logprobs` | boolean | ❌ | 是否返回 token 对数概率 |
| `top_logprobs` | integer | ❌ | 每个输出位置返回 top N token 的对数概率 [0, 20]，需 `logprobs=true` |
| `user_id` | string | ❌ | 业务侧用户标识 [a-zA-Z0-9\-_]，最长 512 |
| `frequency_penalty` | deprecated | - | 已不再支持 |
| `presence_penalty` | deprecated | - | 已不再支持 |

### messages 消息结构

每条消息包含 `role` 和 `content` 字段，支持以下角色：

| 角色 | 说明 | 特有字段 |
|------|------|----------|
| `system` | 系统消息 | `name`（可选） |
| `user` | 用户消息 | `name`（可选） |
| `assistant` | 助手消息 | `name`、`prefix`（Beta）、`reasoning_content`（Beta）、`tool_calls` |
| `tool` | 工具返回消息 | `tool_call_id`（必填，对应 tool call 的 ID） |

**assistant 消息 Beta 字段：**
- `prefix` (bool)：设置为 `true` 强制模型以此 assistant 消息提供的前缀内容开始回答（需 `base_url="https://api.deepseek.com/beta"`）
- `reasoning_content` (string)：思考模式下作为最后一条 assistant 思维链内容的输入（使用此功能时 `prefix` 必须为 `true`）

### thinking 对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | `enabled`（思考模式）或 `disabled`（非思考模式），默认 `enabled` |

### tools 结构

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get weather of a location",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {"type": "string"}
      },
      "required": ["location"]
    },
    "strict": false
  }
}
```

> `strict`（Beta）：设为 `true` 时 API 使用 strict 模式，确保输出符合 JSON schema 定义（需 `base_url="https://api.deepseek.com/beta"`）。

## 响应格式

### 非流式响应（200 OK）

```json
{
  "id": "930c60df-bf64-41c9-a88e-3ec75f81e00e",
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "content": "Hello! How can I help you today?",
        "reasoning_content": null,
        "role": "assistant",
        "tool_calls": null
      },
      "logprobs": null
    }
  ],
  "created": 1705651092,
  "model": "deepseek-v4-pro",
  "object": "chat.completion",
  "system_fingerprint": "fp_...",
  "usage": {
    "completion_tokens": 10,
    "prompt_tokens": 16,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 16,
    "total_tokens": 26,
    "completion_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

### 响应字段说明

| 字段 | 说明 |
|------|------|
| `id` | 对话唯一标识符 |
| `choices[].finish_reason` | 停止原因：`stop` / `length` / `content_filter` / `tool_calls` / `insufficient_system_resource` |
| `choices[].message.content` | 生成内容（思考模式前可能有 `reasoning_content`） |
| `choices[].message.reasoning_content` | 思维链内容（仅思考模式） |
| `choices[].message.tool_calls` | 模型生成的函数调用列表 |
| `usage.prompt_cache_hit_tokens` | 命中上下文缓存的输入 token 数 |
| `usage.prompt_cache_miss_tokens` | 未命中缓存的输入 token 数 |
| `usage.completion_tokens_details.reasoning_tokens` | 思维链 token 数量 |

### 流式响应（SSE）

- 以 `data: [DONE]` 结尾
- 每个 chunk 的 `object` 为 `chat.completion.chunk`
- 设置 `stream_options: {"include_usage": true}` 可在最后传输 usage 统计块

```
data: {"id": "1f633d8bfc...", "choices": [{"index": 0, "delta": {"content": "Hello", "role": "assistant"}, "finish_reason": null}], "created": 1718345013, "model": "deepseek-v4-pro", "object": "chat.completion.chunk", "usage": null}
...
data: [DONE]
```

## 调用示例

### cURL

```bash
curl https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "thinking": {"type": "enabled"},
    "reasoning_effort": "high",
    "stream": false
  }'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key=os.environ.get('DEEPSEEK_API_KEY'),
    base_url="https://api.deepseek.com"
)

response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[
        {"role": "system", "content": "You are a helpful assistant"},
        {"role": "user", "content": "Hello"},
    ],
    stream=False,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}}  # thinking 参数需通过 extra_body 传入
)

print(response.choices[0].message.content)
```

### Node.js (OpenAI SDK)

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const completion = await openai.chat.completions.create({
  messages: [{ role: "system", content: "You are a helpful assistant." }],
  model: "deepseek-v4-pro",
  thinking: {"type": "enabled"},
  reasoning_effort: "high",
  stream: false,
});
console.log(completion.choices[0].message.content);
```

## 注意事项

1. **JSON 模式**：使用 `response_format: {"type": "json_object"}` 时，必须在 system 或 user 消息中指示模型生成 JSON，否则模型可能生成空白内容直到达到 token 限制。
2. **思考模式**：不支持 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 参数（设置不报错但不生效）。
3. **无状态 API**：服务端不记录上下文，多轮对话需客户端拼接完整对话历史。
4. **工具调用**：携带 `tools` 参数的请求，在后续请求中必须完整回传 `reasoning_content`，否则返回 400。
