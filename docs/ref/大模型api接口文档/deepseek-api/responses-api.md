# Responses API

> 接口文档来源：https://api-docs.deepseek.com/zh-cn/api/create-response

## 接口信息

- **方法**: POST
- **路径**: `/responses`
- **认证**: `Authorization: Bearer ${DEEPSEEK_API_KEY}`
- **Content-Type**: `application/json`

## 概述

以 OpenAI Responses API 格式创建模型响应。该 API 为**无状态** API：服务端不存储响应与会话，多轮对话需客户端在每次请求的 `input` 中回传完整对话历史。

主要用途：满足 Codex 等工具的接入需求，通过简单配置即可在 Codex 中使用 DeepSeek 模型。

## 请求参数（Body）

### 核心参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | `deepseek-v4-flash` / `deepseek-v4-pro` |
| `input` | string\|array | ⚠️ | 输入，与 `instructions` 至少传一个 |
| `instructions` | string | ⚠️ | 系统级指令，作为第一条 system 消息 |
| `reasoning` | object | ❌ | 思考模式配置 |
| `max_output_tokens` | integer | ❌ | 响应可生成 token 数上限（含思维链） |
| `stream` | boolean | ❌ | 是否流式输出（语义化 SSE 事件） |
| `temperature` | number | ❌ | 采样温度 [0, 2]，默认 1（思考模式下不生效） |
| `top_p` | number | ❌ | 核采样 [0, 1]，默认 1（思考模式下不生效） |
| `text` | object | ❌ | 文本输出配置 |
| `tools` | array | ❌ | 工具列表（function / web_search） |
| `tool_choice` | object\|string | ❌ | `none` / `auto` / `required` 或指定工具 |
| `top_logprobs` | integer | ❌ | 每个输出位置 top N token 的对数概率 [0, 20] |
| `user` | string | ❌ | 自定义终端用户标识 [a-zA-Z0-9\-_]，最长 512 |

### reasoning 对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `effort` | string | `none`（关闭思考）/ `minimal`/`low`（思考强度 low）/ `medium`/`high`/`xhigh`（强度 high）/ `max`（强度 max）。不传则默认开启 |

### text 对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `format.type` | string | `text`（默认）/ `json_object` / `json_schema` |
| `format.name` | string | schema 名称（`json_schema` 时必填） |
| `format.schema` | object | JSON Schema（`json_schema` 时必填） |

### tools 结构

支持类型：`function`、`web_search`、`web_search_2025_08_26`

- `function`：函数名需非空、≤128 字符、匹配 `^[a-zA-Z0-9_-]+$`，所有工具名称必须唯一
- `web_search`：服务端执行联网搜索

### 输入 item 类型（input）

支持：`message` / `function_call` / `function_call_output` / `reasoning` / `web_search_call`

- 消息角色：`user` / `assistant` / `system` / `developer`（`developer` 视同 `system`）
- `function_call` 需含 `call_id`、`name`、`arguments`（JSON 字符串）
- `function_call_output` 需含 `call_id`、`output`
- 不支持图片、文件输入（`input_image` 内容块不报错但被替换为占位文本）

## 兼容性明细

### 顶层请求参数

| 参数 | 支持情况 |
|------|----------|
| `model` / `input` / `instructions` / `stream` | ✅ 支持 |
| `temperature` / `top_p` | ✅ 支持（思考模式下不生效） |
| `max_output_tokens` / `top_logprobs` / `user` | ✅ 支持 |
| `tools` | ⚠️ 部分支持：`function` / `web_search` 支持，其他忽略 |
| `tool_choice` | ✅ 支持 |
| `reasoning` | ⚠️ `effort` 支持，`summary` 可传但不生成 |
| `text` | ⚠️ `format` 完整支持，`verbosity` 不生效 |
| `parallel_tool_calls` / `max_tool_calls` | 忽略（并行工具调用始终开启） |
| `previous_response_id` / `conversation` / `store` / `background` / `metadata` / `include` / `prompt` / `truncation` / `service_tier` 等 | ❌ 不支持（静默忽略，不报错） |

### Tools

| 类型 | 支持情况 |
|------|----------|
| `function` | ✅ 支持 |
| `web_search` / `web_search_2025_08_26` | ✅ 支持，服务端执行 |
| `custom` | ⚠️ 仅支持 `{"type": "custom", "name": "apply_patch"}`（Codex 兼容） |
| `file_search` / `code_interpreter` / `computer_use` / `mcp` 等 | 忽略 |

## 响应格式（非流式）

```json
{
  "id": "24778070-1c36-4ae0-a4bd-870afc7fc13e",
  "object": "response",
  "created_at": 1753000000,
  "status": "completed",
  "model": "deepseek-v4-flash",
  "output": [
    {
      "type": "reasoning",
      "id": "rs_1",
      "status": "completed",
      "content": [
        {"type": "reasoning_text", "text": "The user greets me. I should reply politely."}
      ]
    },
    {
      "type": "message",
      "id": "msg_1",
      "status": "completed",
      "role": "assistant",
      "content": [
        {"type": "output_text", "text": "Hello! How can I help you today?"}
      ]
    }
  ],
  "usage": {
    "input_tokens": 22,
    "input_tokens_details": {"cached_tokens": 0},
    "output_tokens": 29,
    "output_tokens_details": {"reasoning_tokens": 27},
    "total_tokens": 51
  },
  "error": null,
  "incomplete_details": null
}
```

### 响应字段说明

| 字段 | 说明 |
|------|------|
| `status` | `in_progress` / `completed` / `incomplete` / `failed` |
| `output[].type` | `message` / `reasoning` / `function_call` / `web_search_call` |
| `incomplete_details.reason` | `max_output_tokens` / `content_filter` |
| `usage.input_tokens_details.cached_tokens` | 命中上下文缓存的输入 token 数 |
| `usage.output_tokens_details.reasoning_tokens` | 思维链 token 数 |

## 流式输出（SSE 事件）

设置 `stream: true` 后，响应以语义化 SSE 事件序列返回，每个事件带 `event` 类型字段和递增的 `sequence_number`。流以 `response.completed` / `response.incomplete` / `response.failed` 结束（**没有** `data: [DONE]`）。

### 完整事件列表

| 事件 | 说明 |
|------|------|
| `response.created` | 首个事件，响应已创建 |
| `response.in_progress` | 响应正在生成 |
| `response.output_item.added` / `response.output_item.done` | 输出 item 开始 / 完成 |
| `response.content_part.added` / `response.content_part.done` | 内容块开始 / 完成 |
| `response.reasoning_text.delta` / `response.reasoning_text.done` | 思维链文本增量 / 完成 |
| `response.output_text.delta` / `response.output_text.done` | 输出文本增量 / 完成 |
| `response.function_call_arguments.delta` / `response.function_call_arguments.done` | Function 调用参数增量 / 完成 |
| `response.custom_tool_call_input.delta` / `response.custom_tool_call_input.done` | Custom 工具调用输入增量 / 完成 |
| `response.web_search_call.in_progress` / `.searching` / `.completed` | 联网搜索状态更新 |
| `response.completed` | 正常完成，最后一个事件，携带含 usage 的完整 response |
| `response.incomplete` | 被截断（如达到 max_output_tokens） |
| `response.failed` | 失败，携带含 error 详情的 response |

## 调用示例

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="<your DeepSeek API Key>",
    base_url="https://api.deepseek.com"
)

# 非流式
response = client.responses.create(
    model="deepseek-v4-flash",
    instructions="You are a helpful assistant.",
    input="Hi, how are you?",
)
print(response.output_text)

# 流式
stream = client.responses.create(
    model="deepseek-v4-flash",
    instructions="You are a helpful assistant.",
    input="Hi, how are you?",
    stream=True,
)
for event in stream:
    if event.type == "response.output_text.delta":
        print(event.delta, end="")
```

### cURL

```bash
curl https://api.deepseek.com/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
    "model": "deepseek-v4-flash",
    "instructions": "You are a helpful assistant.",
    "input": "Hi, how are you?"
  }'
```
