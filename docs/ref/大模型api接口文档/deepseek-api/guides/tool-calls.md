# Tool Calls（函数调用）

> 指南文档来源：https://api-docs.deepseek.com/zh-cn/guides/tool_calls

## 概述

Tool Calls 让模型能够调用外部工具（function calling），以增强自身能力。具体 API 格式参考 [Chat Completions API](../chat-completions.md)。

## 非思考模式

### 调用流程

1. 用户发起问题
2. 模型返回 function 调用（`tool_calls`）
3. 用户侧执行函数，将结果以 `tool` 消息传给模型
4. 模型基于工具结果返回自然语言回答

### 样例代码

```python
from openai import OpenAI

def send_messages(messages):
    response = client.chat.completions.create(
        model="deepseek-v4-pro",
        messages=messages,
        tools=tools
    )
    return response.choices[0].message

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com",
)

# 工具定义
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather of a location, the user should supply a location first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city and state, e.g. San Francisco, CA",
                    }
                },
                "required": ["location"]
            },
        }
    },
]

messages = [{"role": "user", "content": "How's the weather in Hangzhou, Zhejiang?"}]
message = send_messages(messages)
print(f"User>\t {messages[0]['content']}")

# 获取模型返回的工具调用
tool = message.tool_calls[0]
messages.append(message)

# 用户执行函数后，将结果回传给模型
messages.append({"role": "tool", "tool_call_id": tool.id, "content": "24℃"})
message = send_messages(messages)
print(f"Model>\t {message.content}")
```

执行流程：
1. 用户：询问现在的天气
2. 模型：返回 function `get_weather({location: 'Hangzhou'})`
3. 用户：调用 function `get_weather({location: 'Hangzhou'})`，并传给模型
4. 模型：返回自然语言 "The current temperature in Hangzhou is 24°C."

> 注：`get_weather` 函数功能需由用户实现，模型本身不执行具体函数。

## 思考模式

从 DeepSeek-V3.2 开始，API 支持了思考模式下的工具调用能力，详见[思考模式](./thinking-mode.md#工具调用)。

> **重要**：思考模式下携带 `tools` 参数的请求，后续必须完整回传 `reasoning_content`。

## strict 模式（Beta）

在 `strict` 模式下，模型在输出 Function 调用时会严格遵循 Function 的 JSON Schema 格式要求，确保输出符合用户定义。思考与非思考模式下的工具调用均可使用 strict 模式。

### 使用前提

1. 设置 `base_url="https://api.deepseek.com/beta"` 开启 Beta 功能
2. 传入的 `tools` 列表中，所有 `function` 均需设置 `strict` 属性为 `true`
3. 服务端会校验 JSON Schema，不符合规范或遇到不支持的 Schema 类型将返回错误

### strict 模式 tool 定义样例

```json
{
    "type": "function",
    "function": {
        "name": "get_weather",
        "strict": true,
        "description": "Get weather of a location, the user should supply a location first.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The city and state, e.g. San Francisco, CA",
                }
            },
            "required": ["location"],
            "additionalProperties": false
        }
    }
}
```

## strict 模式支持的 JSON Schema 类型

| 类型 | 说明 |
|------|------|
| object | 所有属性需设为 required，`additionalProperties` 必须为 `false` |
| string | 支持 `pattern`（正则）、`format`（email/hostname/ipv4/ipv6/uuid）；不支持 minLength/maxLength |
| number/integer | 支持 `const`/`default`/`minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf` |
| boolean | 支持 |
| array | 不支持 minItems/maxItems |
| enum | 确保输出为预期选项之一 |
| anyOf | 匹配多个 schema 中的任意一个 |
| $ref / $def | 支持模块化定义与递归结构 |

### 示例：object 类型

```json
{
    "type": "object",
    "properties": {
        "name": { "type": "string" },
        "age": { "type": "integer" }
    },
    "required": ["name", "age"],
    "additionalProperties": false
}
```

### 示例：string 类型（format / pattern）

```json
{
    "type": "object",
    "properties": {
        "user_email": {
            "type": "string",
            "description": "The user's email address",
            "format": "email"
        },
        "zip_code": {
            "type": "string",
            "description": "Six digit postal code",
            "pattern": "^\\d{6}$"
        }
    }
}
```

### 示例：enum 类型

```json
{
    "type": "object",
    "properties": {
        "order_status": {
            "type": "string",
            "description": "Ordering status",
            "enum": ["pending", "processing", "shipped", "cancelled"]
        }
    }
}
```

### 示例：anyOf 类型

```json
{
    "type": "object",
    "properties": {
        "account": {
            "anyOf": [
                { "type": "string", "format": "email", "description": "可以是电子邮件地址" },
                { "type": "string", "pattern": "^\\d{11}$", "description": "或11位手机号码" }
            ]
        }
    }
}
```

### 示例：$ref 和 $def

```json
{
    "type": "object",
    "properties": {
        "report_date": {
            "type": "string",
            "description": "The date when the report was published"
        },
        "authors": {
            "type": "array",
            "description": "The authors of the report",
            "items": {
                "$ref": "#/$def/author"
            }
        }
    },
    "required": ["report_date", "authors"],
    "additionalProperties": false,
    "$def": {
        "author": {
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "author's name" },
                "institution": { "type": "string", "description": "author's institution" },
                "email": { "type": "string", "format": "email", "description": "author's email" }
            },
            "additionalProperties": false,
            "required": ["name", "institution", "email"]
        }
    }
}
```
