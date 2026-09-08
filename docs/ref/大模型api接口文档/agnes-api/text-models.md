# 文本模型（Text Models）

> 文档来源：
> - https://wiki.agnes-ai.com/en/docs/agnes-20-flash.md
> - https://wiki.agnes-ai.com/en/docs/agnes-25-flash.md
> - https://wiki.agnes-ai.com/en/docs/agnes-25-pro-alpha.md
> - https://wiki.agnes-ai.com/en/docs/agnes-25-pro.md

## 模型总览

| 模型 ID | 类型 | 上下文窗口 | 最大输出 | 输入模态 | 输出模态 | 发布时间 |
|---------|------|-----------|----------|----------|----------|----------|
| `agnes-2.0-flash` | 快速高效模型 | 512K | 65.5K | 文本、图片 URL | 文本 | - |
| `agnes-2.5-flash` | 2.0 升级版（GA） | 512K | 65.5K | 文本、图片 URL | 文本 | - |
| `agnes-2.5-pro-alpha` | 付费推理模型 | 1M | 65536 | 文本、图片 | 文本 | 2026-07-24 |
| `agnes-2.5-pro` | 2.5 Pro 商业稳定版 | 1M | 65536 | 文本、图片 | 文本 | 2026-08-01 |

### 功能能力

| 能力 | 2.0 Flash | 2.5 Flash | 2.5 Pro Alpha | 2.5 Pro |
|------|-----------|-----------|---------------|---------|
| 多轮对话 | ✅ | ✅ | ✅ | ✅ |
| 图片 URL 输入 | ✅ | ✅ | ✅ | ✅ |
| 图片理解 | ✅ | ✅ | ✅ | ✅ |
| 工具调用 | ✅ | ✅ | ✅ | ✅ |
| Agent 工作流 | ✅ | ✅（增强） | ✅ | ✅ |
| 代码任务 | ✅ | ✅（专项优化） | ✅ | ✅ |
| 流式输出 | ✅ | ✅ | ✅ | ✅ |
| 思考模式 | ✅ | ✅ | ✅（推理） | ✅（推理） |

### 价格

**agnes-2.0-flash / agnes-2.5-flash：**

| 类型 | 标准价格 | 当前价格 |
|------|----------|----------|
| 输入 tokens | $0.03 / 1M | $0 / 1M |
| 输出 tokens | $0.15 / 1M | $0 / 1M |

**agnes-2.5-pro-alpha / agnes-2.5-pro：**

| 类型 | 美元价格 |
|------|----------|
| 输入缓存命中（Cache Read） | $0.0038 / 1M tokens |
| 输入缓存未命中（Input） | $0.45 / 1M tokens |
| 输出 | $0.90 / 1M tokens |

---

## 一、Chat Completions API（OpenAI 兼容）

### 端点

```text
POST https://apihub.agnes-ai.com/v1/chat/completions
```

### 请求头

```bash
-H "Authorization: Bearer YOUR_API_KEY"
-H "Content-Type: application/json"
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称（见上表） |
| `messages` | array | ✅ | 对话消息，包含 `system` / `user` / `assistant` 消息 |
| `messages[].content` | string / array | ✅ | 消息内容，可为纯文本或包含 `text` 和 `image_url` 的内容块数组 |
| `temperature` | number | ❌ | 控制随机性，较低值输出更确定 |
| `top_p` | number | ❌ | 核采样控制 |
| `max_tokens` | number | ❌ | 响应最大生成 token 数 |
| `stream` | boolean | ❌ | 是否启用流式输出 |
| `tools` | array | ❌ | 工具调用（function calling）定义 |
| `tool_choice` | string / object | ❌ | 控制模型是否及如何使用工具 |
| `chat_template_kwargs` | object | ❌ | 扩展字段，用于在 OpenAI 兼容请求中启用思考等特性 |
| `thinking` | object | ❌ | 在 Anthropic 兼容请求中启用思考模式的字段 |

### 图片 URL 输入

`messages[].content` 支持文本与图片 URL 混合：

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Describe the content of this image."
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "https://example.com/image.jpg"
      }
    }
  ]
}
```

### 请求示例

**基础对话：**

```bash
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful AI assistant."
      },
      {
        "role": "user",
        "content": "Explain how autonomous agents use tools to complete tasks."
      }
    ],
    "temperature": 0.7,
    "max_tokens": 1024
  }'
```

**流式输出：**

```bash
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": "Write a short product introduction for an AI assistant app."
      }
    ],
    "stream": true
  }'
```

**工具调用（Tool Calling）：**

```bash
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": "What is the weather like in Singapore today?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get the current weather for a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "description": "The city and country"
              }
            },
            "required": ["location"]
          }
        }
      }
    ]
  }'
```

**图片理解：**

```bash
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Describe the content of this image."
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://example.com/image.jpg"
            }
          }
        ]
      }
    ]
  }'
```

### 响应格式

```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1774432125,
  "model": "agnes-2.5-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Autonomous agents use tools by understanding the user's goal..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 35,
    "completion_tokens": 58,
    "total_tokens": 93
  }
}
```

### 响应字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 补全请求唯一 ID |
| `object` | string | 对象类型，通常为 `chat.completion` |
| `created` | integer | 请求时间戳 |
| `model` | string | 使用的模型 |
| `choices[].message.role` | string | 消息发送者角色 |
| `choices[].message.content` | string | 模型生成的内容 |
| `choices[].finish_reason` | string | 生成停止原因（`stop` / `length` 等） |
| `usage` | object | Token 用量信息 |

---

## 二、Responses API（OpenAI 格式）

### 端点

```text
POST https://apihub.agnes-ai.com/v1/responses
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称 |
| `input` | string / array | ✅ | 纯文本提示或结构化输入消息数组 |
| `max_output_tokens` | integer | ❌ | 最大输出预算。推理模型建议设置较大值以避免 `incomplete` 响应 |

### 请求示例

**文本输入：**

```bash
curl https://apihub.agnes-ai.com/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "input": "Explain how autonomous agents use tools.",
    "max_output_tokens": 1024
  }'
```

**结构化输入：**

```bash
curl https://apihub.agnes-ai.com/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "input": [
      {
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": "Explain how autonomous agents use tools."
          }
        ]
      }
    ],
    "max_output_tokens": 1024
  }'
```

### 响应格式

```json
{
  "id": "resp_xxx",
  "object": "response",
  "status": "completed",
  "model": "agnes-2.5-flash",
  "output": [
    {
      "type": "reasoning",
      "summary": []
    },
    {
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "Autonomous agents use tools to retrieve data and perform actions."
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 40,
    "output_tokens": 80,
    "total_tokens": 120
  },
  "error": null,
  "incomplete_details": null
}
```

### 响应字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 响应唯一 ID |
| `object` | string | 对象类型，通常为 `response` |
| `status` | string | 响应状态（`completed` / `incomplete` 等） |
| `output` | array | 有序响应项，包含 reasoning 和 assistant 消息 |
| `output[].type` | string | 项类型（`reasoning` / `message`） |
| `output[].content[].type` | string | 内容类型，生成文本为 `output_text` |
| `output[].content[].text` | string | 生成的助手文本 |
| `usage` | object | Token 用量 |
| `error` | object / null | 请求失败时的错误详情 |
| `incomplete_details` | object / null | 响应提前停止的原因 |

> **注意**：当前响应**不包含顶层 `output_text` 便捷字段**。需从 `output[]` 中 `type` 为 `message` 且 `content[].type` 为 `output_text` 的项中提取生成文本。

> **提示**：
> - reasoning 项可选，可使用 `content[].reasoning_text` 或 `summary[].summary_text`
> - token 用量字段名因模型而异：同时支持 `input_tokens` / `output_tokens` 与 `prompt_tokens` / `completion_tokens`
> - 若 `status` 为 `incomplete`，检查 `incomplete_details` 并以更大的 `max_output_tokens` 重试

---

## 三、Messages API（Anthropic 兼容）

### 端点

```text
POST https://apihub.agnes-ai.com/v1/messages
```

### 请求头

```bash
-H "x-api-key: YOUR_API_KEY"
-H "anthropic-version: 2023-06-01"
-H "Content-Type: application/json"
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称 |
| `max_tokens` | integer | ✅ | 最大输出 token 数。推理模型建议设置较大值 |
| `messages` | array | ✅ | 对话消息（`user` / `assistant` 角色） |
| `messages[].role` | string | ✅ | 消息角色（`user` / `assistant`） |
| `messages[].content` | string / array | ✅ | 纯文本或 Anthropic 兼容内容块数组 |
| `system` | string / array | ❌ | 系统指令 |
| `temperature` | number | ❌ | 控制输出随机性 |
| `stream` | boolean | ❌ | 是否流式返回 |

### 请求示例

```bash
curl https://apihub.agnes-ai.com/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "max_tokens": 1024,
    "system": "You are a helpful AI assistant.",
    "messages": [
      {
        "role": "user",
        "content": "Explain how autonomous agents use tools."
      }
    ]
  }'
```

### 响应格式

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.5-flash",
  "content": [
    {
      "type": "text",
      "text": "Autonomous agents use tools to retrieve information and perform actions."
    }
  ],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 290,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 28
  }
}
```

### 响应字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 消息唯一 ID |
| `type` | string | 对象类型，通常为 `message` |
| `role` | string | 响应角色，通常为 `assistant` |
| `model` | string | 使用的模型 |
| `content` | array | 有序响应内容块 |
| `content[].type` | string | 内容块类型，生成文本为 `text` |
| `content[].text` | string | 生成的助手文本 |
| `stop_reason` | string | 停止原因（`end_turn` / `max_tokens` 等） |
| `usage.input_tokens` | integer | 输入 token 数 |
| `usage.output_tokens` | integer | 输出 token 数 |
| `usage.cache_creation_input_tokens` | integer | 写入 prompt 缓存的输入 token |
| `usage.cache_read_input_tokens` | integer | 从 prompt 缓存读取的输入 token |

---

## 四、思考模式（Thinking Mode）

对编码、调试、推理和 Agent 工作流，可启用思考模式以提升任务分解与问题解决质量。

### OpenAI 兼容格式

```json
{
  "model": "agnes-2.5-flash",
  "messages": [
    {
      "role": "user",
      "content": "Help me write a Python script to process a CSV file."
    }
  ],
  "chat_template_kwargs": {
    "enable_thinking": true
  }
}
```

### Anthropic 兼容格式

```json
{
  "model": "agnes-2.5-flash",
  "messages": [
    {
      "role": "user",
      "content": "Help me refactor this TypeScript function and explain the changes."
    }
  ],
  "thinking": {
    "type": "enabled",
    "budget_tokens": 2048
  }
}
```

> **提示**：常规编码任务从 `budget_tokens: 2048` 开始；复杂调试、重构或多步 Agent 工作流可适当增加预算。

---

## 五、升级路径（2.0 Flash → 2.5 Flash）

对于已使用 `agnes-2.0-flash` 的开发者，迁移非常简单，通常只需替换 `model` 值：

| 项目 | Agnes 2.0 Flash | Agnes 2.5 Flash |
|------|-----------------|-----------------|
| 端点 | `POST /v1/chat/completions` | `POST /v1/chat/completions` |
| Base URL | `https://apihub.agnes-ai.com/v1` | `https://apihub.agnes-ai.com/v1` |
| 模型名 | `agnes-2.0-flash` | `agnes-2.5-flash` |
| 消息格式 | OpenAI 兼容 `messages` | 相同 |
| 流式 | `stream: true` | 相同 |
| 工具调用 | `tools` 和 `tool_choice` | 相同 |
| 图片 URL 输入 | `messages[].content[].image_url` | 相同 |

---

## 六、集成检查清单

- [ ] 使用正确的模型名称（`agnes-2.5-flash` / `agnes-2.5-pro` 等）
- [ ] 基础对话补全请求必须包含 `model` 和 `messages`
- [ ] 图片输入必须使用公开可访问的 `image_url` 值
- [ ] 需要流式响应时设置 `stream: true`
- [ ] 付费模型（2.5 Pro 系列）需确认账户有权访问，并跟踪缓存读取、输入和输出 token 用量

## 最佳实践提示

- **提示词结构**：`[角色] + [任务] + [上下文] + [要求] + [输出格式]`
- **推理密集型任务**：使用 `agnes-2.5-pro` / `agnes-2.5-pro-alpha`（正确性和多步推理比延迟更重要）
- **编码任务**：提供目标语言、框架、现有代码、错误信息、预期行为和约束条件；调试复杂问题时先要求根因分析再给补丁
- **长上下文任务**：在提示词中使用结构化章节、文件名或文档标签，便于模型引用来源
