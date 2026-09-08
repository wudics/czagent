# Create a Message（Anthropic 兼容）

> 接口文档来源：https://api-docs.siliconflow.cn/docs/api/messages-post

## 接口信息

- **方法**: POST
- **路径**: `/v1/messages`
- **认证**: `Authorization: Bearer {API_KEY}`
- **Content-Type**: `application/json`
- **兼容性**: Anthropic Messages 格式

## 概述

以 Anthropic Messages API 格式为给定对话创建模型响应，支持流式输出、工具调用、思考模式控制等。

## 请求参数（Body）

### 核心参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，如 `deepseek-ai/DeepSeek-V4-Flash`。完整列表见 [Models](https://cloud.siliconflow.cn/models?types=chat) |
| `messages` | array | ✅ | 对话消息列表 |
| `system` | string\|array | ❌ | 系统提示词 |
| `max_tokens` | integer | ✅ | 最大生成 token 数（不含思维链）。建议预留约 10k tokens 缓冲 |
| `stop_sequences` | array | ❌ | 自定义停止序列 |
| `stream` | boolean | ❌ | 是否流式输出（SSE），以 `data: [DONE]` 结尾 |
| `temperature` | number | ❌ | 随机性控制，≤ 2，默认 0.7 |
| `top_p` | number | ❌ | 核采样，≤ 1，默认 0.7 |
| `top_k` | number | ❌ | ≤ 100，默认 50 |
| `tools` | array | ❌ | 工具定义列表 |
| `tool_choice` | object | ❌ | 工具选择方式：Auto / Tool / None |
| `thinking` | object | ❌ | 思考控制参数 |

### thinking 对象

```json
{
  "type": "enabled",
  "budget_tokens": 1024
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | `enabled`（启用思考）或 `disabled`（禁用思考） |
| `budget_tokens` | integer | 思考 token 预算，控制思维链长度（`enabled` 时必填） |

### tool_choice 三种模式

**Auto**（模型自动决定是否使用工具）：
```json
{"type": "auto", "disable_parallel_tool_use": false}
```

**Tool**（使用指定工具）：
```json
{"type": "tool", "name": "tool_name", "disable_parallel_tool_use": false}
```

**None**（不使用工具）：
```json
{"type": "none"}
```

### tools 结构

每个工具定义包含：
- `name`：工具名称
- `description`：工具描述（建议提供）
- `input_schema`：工具输入的 [JSON Schema](https://json-schema.org/draft/2020-12)

```json
{
  "name": "get_current_weather",
  "description": "Get the current weather in a given location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {"type": "string", "description": "The city and state, e.g. San Francisco, CA"},
      "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
    },
    "required": ["location"]
  }
}
```

### messages 消息结构

VLM 模型支持多模态输入：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Describe this image"},
    {"type": "image", "source": {"type": "url", "url": "https://example.com/image.jpg"}}
  ]
}
```

## 响应格式（200 OK）

```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "...",
      "signature": "tvshsltrjs"
    },
    {
      "text": "Hello! I'm GLM, trained by Z.ai. How can I assist you today?",
      "type": "text"
    }
  ],
  "id": "msg_T15jjp718fACotrwiLp3KwVu",
  "model": "deepseek-ai/DeepSeek-V4-Flash",
  "role": "assistant",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "type": "message",
  "usage": {
    "input_tokens": 6,
    "output_tokens": 215
  }
}
```

### 响应字段说明

| 字段 | 说明 |
|------|------|
| `type` | 恒为 `message` |
| `role` | 恒为 `assistant` |
| `content` | 内容块数组，可能包含 `text` / `thinking` 类型 |
| `stop_reason` | `end_turn`（自然停止）/ `max_tokens`（超出限制）/ `tool_use`（调用工具）/ `refusal`（策略拦截） |
| `stop_sequence` | 命中的自定义停止序列（如有） |

## 调用示例

### cURL

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "messages": [
      {"role": "user", "content": "Hello, please introduce yourself."}
    ],
    "max_tokens": 4096
  }'
```

### Python

```python
import requests

url = "https://api.siliconflow.cn/v1/messages"
payload = {
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "messages": [
        {"role": "user", "content": "Hello, please introduce yourself."}
    ],
    "max_tokens": 4096
}
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

response = requests.post(url, json=payload, headers=headers)
print(response.text)
```

### 流式 + 工具调用

```python
import requests

url = "https://api.siliconflow.cn/v1/messages"
payload = {
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "messages": [
        {"role": "user", "content": "What is the weather like in Boston today?"},
        {"role": "assistant", "content": "Boston is sunny today, 20°C."},
        {"role": "user", "content": "What about New York?"}
    ],
    "max_tokens": 4096,
    "stream": True,
    "tools": [
        {
            "name": "get_current_weather",
            "description": "Get the current weather in a given location",
            "input_schema": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city and state, e.g. San Francisco, CA"
                    },
                    "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                },
                "required": ["location"]
            }
        }
    ],
    "tool_choice": {"type": "auto"}
}
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

response = requests.post(url, json=payload, headers=headers, stream=True)
for line in response.iter_lines():
    if line:
        print(line.decode("utf-8"))
```
