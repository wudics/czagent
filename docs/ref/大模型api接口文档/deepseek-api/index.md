# DeepSeek API 接口文档

> 文档来源：https://api-docs.deepseek.com/zh-cn/
> 整理日期：2026-08-21

## 概述

DeepSeek API 使用与 OpenAI/Anthropic 兼容的 API 格式，通过修改配置，可以使用 OpenAI/Anthropic SDK 来访问 DeepSeek API，或使用与 OpenAI/Anthropic API 兼容的软件。

## 基础信息

| 参数 | 值 |
|------|-----|
| Base URL (OpenAI 格式) | `https://api.deepseek.com` |
| Base URL (Anthropic 格式) | `https://api.deepseek.com/anthropic` |
| Base URL (Beta 功能) | `https://api.deepseek.com/beta` |
| API Key 申请 | https://platform.deepseek.com/api_keys |

> 说明：Beta 功能（对话前缀续写、FIM 补全、strict 模式）需设置 `base_url="https://api.deepseek.com/beta"` 使用。

## 可用模型

| 模型 ID | 模型版本 | 上下文长度 | 最大输出 | 并发限制 |
|---------|----------|-----------|----------|----------|
| `deepseek-v4-flash` | DeepSeek-V4-Flash-0731 | 1M | 384K | 2500 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 384K | 500 |

### 功能支持矩阵

| 功能 | deepseek-v4-flash | deepseek-v4-pro |
|------|-------------------|-----------------|
| JSON Output | ✅ | ✅ |
| Tool Calls | ✅ | ✅ |
| Responses API | ✅ | ✅ |
| Anthropic API | ✅ | ✅ |
| 对话前缀续写（Beta） | ✅ | ✅ |
| FIM 补全（Beta） | ⚠️ 仅非思考模式 | ⚠️ 仅非思考模式 |

## 价格（人民币 / 百万 tokens）

### deepseek-v4-flash

| 场景 | 空闲时段 | 高峰时段 |
|------|----------|----------|
| 输入（缓存命中） | ¥0.05 | ¥0.10 |
| 输入（缓存未命中） | ¥1.50 | ¥3.00 |
| 输出 | ¥4.50 | ¥9.00 |

### deepseek-v4-pro

| 场景 | 空闲时段 | 高峰时段 |
|------|----------|----------|
| 输入（缓存命中） | ¥0.15 | ¥0.30 |
| 输入（缓存未命中） | ¥4.50 | ¥9.00 |
| 输出 | ¥13.50 | ¥27.00 |

> **高峰时段**：北京时间 9:00-12:00、14:00-18:00（其余为空闲时段，价格为高峰时段一半）。
> 扣费规则：扣减费用 = token 消耗量 × 模型单价，优先扣减赠送余额。

## 错误码

| 错误码 | 描述 | 原因 | 解决方法 |
|--------|------|------|----------|
| 400 | 格式错误 | 请求体格式错误 | 根据错误信息提示修改请求体 |
| 401 | 认证失败 | API key 错误，认证失败 | 检查 API key，如无先创建 |
| 402 | 余额不足 | 账号余额不足 | 确认账户余额并充值 |
| 422 | 参数错误 | 请求体参数错误 | 根据错误信息提示修改相关参数 |
| 429 | 请求速率达到上限 | TPM 或 RPM 达到上限 | 合理规划请求速率 |
| 500 | 服务器故障 | 服务器内部故障 | 等待后重试，持续则联系 |
| 503 | 服务器繁忙 | 服务器负载过高 | 稍后重试 |

## API 端点索引

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/chat/completions` | POST | Chat Completions API（对话补全） | [chat-completions.md](./chat-completions.md) |
| `/responses` | POST | Responses API（OpenAI 格式） | [responses-api.md](./responses-api.md) |
| `/completions` | POST | FIM 补全 API（Beta） | [fim-completion.md](./fim-completion.md) |
| `/models` | GET | 获取模型列表 | [list-models.md](./list-models.md) |
| `/user/balance` | GET | 查询余额 | [list-models.md](./list-models.md) |

## 功能指南索引

| 指南 | 说明 | 文档 |
|------|------|------|
| 思考模式 | 思考模式开关与思考强度控制 | [guides/thinking-mode.md](./guides/thinking-mode.md) |
| 多轮对话 | 无状态 API 的多轮对话实现 | [guides/multi-round-chat.md](./guides/multi-round-chat.md) |
| Tool Calls | 函数调用能力 | [guides/tool-calls.md](./guides/tool-calls.md) |
| JSON Output | 确保模型输出合法 JSON | [guides/json-mode.md](./guides/json-mode.md) |
| 对话前缀续写（Beta） | 强制模型从指定前缀开始输出 | [guides/chat-prefix-completion.md](./guides/chat-prefix-completion.md) |
| FIM 补全（Beta） | 中间填充补全 | [guides/fim-completion.md](./guides/fim-completion.md) |
| 上下文硬盘缓存 | 缓存机制说明 | [guides/kv-cache.md](./guides/kv-cache.md) |
| Responses API | OpenAI Responses 格式兼容 | [guides/responses-api.md](./guides/responses-api.md) |
| Anthropic API | Anthropic 格式兼容支持 | [guides/anthropic-api.md](./guides/anthropic-api.md) |
