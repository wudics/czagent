# 使用 Anthropic API

> 指南文档来源：https://api-docs.deepseek.com/zh-cn/guides/anthropic_api

## 概述

DeepSeek API 新增了对 Anthropic API 格式的支持，其 `base_url` 为 `https://api.deepseek.com/anthropic`。通过简单配置，即可将 DeepSeek 的能力接入到 Anthropic API 生态中（如 Claude Code、Claude Desktop 等工具）。

## 将 DeepSeek 模型接入 Claude Code

请参考 [接入 Claude Code 指南](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code)。

## 通过 Anthropic API 调用 DeepSeek 模型

### 1. 安装 Anthropic SDK

```bash
pip install anthropic
```

### 2. 配置环境变量

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY=${YOUR_API_KEY}
```

### 3. 调用 API

```python
import anthropic

client = anthropic.Anthropic()

message = client.messages.create(
    model="deepseek-v4-pro",
    max_tokens=1000,
    system="You are a helpful assistant.",
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Hi, how are you?"
                }
            ]
        }
    ]
)

print(message.content)
```

> **注意**：当给 DeepSeek 的 Anthropic API 传入不支持的模型名时，API 后端会自动将其映射到 `deepseek-v4-flash` 模型。

## Anthropic 模型映射

使用 Anthropic API 时，传入的 claude 模型名会被映射：

| 传入模型名 | 映射到 |
|-----------|--------|
| `claude-opus` 开头 | `deepseek-v4-pro` |
| `claude-haiku`、`claude-sonnet` 开头 | `deepseek-v4-flash` |

> 通过该映射，使用新版 Claude Desktop APP 的 developer 模式时，可以绕过 APP 对模型名的限制，只需改动 base_url 和 api_key 即可接入 DeepSeek 模型。

## Anthropic API 兼容性细节

### HTTP Header

| Header | 支持情况 |
|--------|----------|
| `anthropic-beta` | Ignored（忽略） |
| `anthropic-version` | Ignored（忽略） |
| `x-api-key` | Fully Supported（完全支持） |

### Simple Fields

| 字段 | 支持情况 |
|------|----------|
| `model` | 使用 DeepSeek Model（有映射） |
| `max_tokens` | ✅ 完全支持 |
| `container` / `mcp_servers` / `service_tier` | 忽略 |
| `metadata` | `user_id` 支持，其他忽略 |
| `stop_sequences` | ✅ 完全支持 |
| `stream` | ✅ 完全支持 |
| `system` | ✅ 完全支持 |
| `temperature` | ✅ 完全支持（范围 [0.0 ~ 2.0]） |
| `thinking` | ✅ 支持（`budget_tokens` 被忽略） |
| `output_config` | 仅 `effort` 支持 |
| `top_k` | 忽略 |
| `top_p` | ✅ 完全支持 |

### Tool Fields

#### tools

| 字段 | 支持情况 |
|------|----------|
| `name` | ✅ 完全支持 |
| `input_schema` | ✅ 完全支持 |
| `description` | ✅ 完全支持 |
| `cache_control` | 忽略 |

#### tool_choice

| 值 | 支持情况 |
|----|----------|
| `none` | ✅ 完全支持 |
| `auto` | ✅ 支持（`disable_parallel_tool_use` 忽略） |
| `any` | ✅ 支持（`disable_parallel_tool_use` 忽略） |
| `tool` | ✅ 支持（`disable_parallel_tool_use` 忽略） |

### Message Fields

| 字段 | 变体 | 子字段 | 支持情况 |
|------|------|--------|----------|
| `content` | string | - | ✅ 完全支持 |
| | array, type="text" | `text` | ✅ 完全支持 |
| | | `cache_control` / `citations` | 忽略 |
| | array, type="image" | - | ❌ 不支持 |
| | array, type="document" | - | ❌ 不支持 |
| | array, type="search_result" | - | ❌ 不支持 |
| | array, type="thinking" | - | ✅ 支持 |
| | array, type="redacted_thinking" | - | ❌ 不支持 |
| | array, type="tool_use" | `id` / `input` / `name` | ✅ 完全支持 |
| | | `cache_control` | 忽略 |
| | array, type="tool_result" | `tool_use_id` / `content` | ✅ 完全支持 |
| | | `cache_control` | 忽略 |
| | | `is_error` | 忽略 |
| | array, type="server_tool_use" | - | ✅ 支持 |
| | array, type="web_search_tool_result" | - | ✅ 支持 |
| | array, type="code_execution_tool_result" | - | ❌ 不支持 |
| | array, type="mcp_tool_use" / "mcp_tool_result" | - | ❌ 不支持 |
| | array, type="container_upload" | - | ❌ 不支持 |
