# FIM 补全 API（Beta）

> 接口文档来源：https://api-docs.deepseek.com/zh-cn/api/create-completion

## 接口信息

- **方法**: POST
- **路径**: `/completions`
- **Base URL**: `https://api.deepseek.com/beta`（需开启 Beta 功能）
- **认证**: `Authorization: Bearer ${DEEPSEEK_API_KEY}`

## 概述

FIM (Fill In the Middle) 补全 API，用户提供前缀（prompt）和后缀（suffix，可选），模型补全中间内容。常用于代码补全、内容续写等场景。

## 请求参数（Body）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型 ID，仅支持 `deepseek-v4-pro` |
| `prompt` | string | ✅ | 用于生成完成内容的前缀 |
| `suffix` | string | ❌ | 被补全内容的后缀 |
| `max_tokens` | integer | ❌ | 最大生成 token 数 |
| `temperature` | number | ❌ | 采样温度 [0, 2]，默认 1 |
| `top_p` | number | ❌ | 核采样 [0, 1]，默认 1 |
| `stop` | string\|array | ❌ | 停止序列，最多 16 个 string |
| `stream` | boolean | ❌ | 是否流式输出（SSE），以 `data: [DONE]` 结尾 |
| `stream_options` | object | ❌ | 流式选项，`stream=true` 时可用，`include_usage` 控制 usage 统计 |
| `echo` | boolean | ❌ | 在输出中把 prompt 内容也输出 |
| `logprobs` | integer | ❌ | 输出 logprobs 最可能 token 的对数概率 [0, 20] |
| `frequency_penalty` | deprecated | - | 已不再支持 |
| `presence_penalty` | deprecated | - | 已不再支持 |

> **注意事项**：模型最大补全长度为 **4K tokens**。

## 响应格式

```json
{
  "id": "string",
  "object": "text_completion",
  "created": 0,
  "model": "deepseek-v4-pro",
  "system_fingerprint": "string",
  "choices": [
    {
      "index": 0,
      "text": "string",
      "finish_reason": "stop",
      "logprobs": {
        "text_offset": [0],
        "token_logprobs": [0],
        "tokens": ["string"],
        "top_logprobs": [{}]
      }
    }
  ],
  "usage": {
    "completion_tokens": 0,
    "prompt_tokens": 0,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 0,
    "total_tokens": 0,
    "completion_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

### 关键字段

- `choices[].text`：补全的文本内容
- `choices[].finish_reason`：`stop` / `length` / `content_filter` / `insufficient_system_resource`
- `object`：恒为 `text_completion`

## 调用示例

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com/beta",
)

# 补全斐波那契函数中间部分
response = client.completions.create(
    model="deepseek-v4-pro",
    prompt="def fib(a):",
    suffix="    return fib(a-1) + fib(a-2)",
    max_tokens=128
)
print(response.choices[0].text)
```

### cURL

```bash
curl https://api.deepseek.com/beta/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
    "model": "deepseek-v4-pro",
    "prompt": "def fib(a):",
    "suffix": "    return fib(a-1) + fib(a-2)",
    "max_tokens": 128
  }'
```

## 相关配置

- 可参考 [DeepSeek × Continue 配置指南](https://github.com/deepseek-ai/awesome-deepseek-integration/blob/main/docs/continue/README_cn.md) 配置 VSCode 代码补全插件（Continue）。
