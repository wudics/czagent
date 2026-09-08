# 多轮对话

> 指南文档来源：https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat

## 概述

DeepSeek `/chat/completions` API 是一个**无状态** API，即服务端不记录用户请求的上下文。用户在每次请求时，**需将之前所有对话历史拼接好后**，传递给对话 API。

## 实现方式

多轮对话的核心在于：
1. 第一轮请求时，只传当前的用户消息
2. 后续每轮请求时：
   - 将上一轮模型的输出（`assistant` 消息）追加到 `messages` 末尾
   - 将新的用户提问追加到 `messages` 末尾
   - 将完整的 `messages` 列表传给 API

## 样例代码

```python
from openai import OpenAI

client = OpenAI(api_key="<DeepSeek API Key>", base_url="https://api.deepseek.com")

# Round 1
messages = [{"role": "user", "content": "What's the highest mountain in the world?"}]
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages
)
messages.append(response.choices[0].message)
print(f"Messages Round 1: {messages}")

# Round 2
messages.append({"role": "user", "content": "What is the second?"})
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages
)
messages.append(response.choices[0].message)
print(f"Messages Round 2: {messages}")
```

## 消息拼接过程示例

**第一轮**请求时，传递给 API 的 `messages` 为：

```json
[
    {"role": "user", "content": "What's the highest mountain in the world?"}
]
```

**第二轮**请求时：
1. 将第一轮中模型的输出添加到 `messages` 末尾
2. 将新的提问添加到 `messages` 末尾

最终传递给 API 的 `messages` 为：

```json
[
    {"role": "user", "content": "What's the highest mountain in the world?"},
    {"role": "assistant", "content": "The highest mountain in the world is Mount Everest."},
    {"role": "user", "content": "What is the second?"}
]
```

## 注意事项

1. **思考模式相关**：如果模型进行了工具调用，中间 `assistant` 的 `reasoning_content` 必须参与上下文拼接并回传给 API（详见[思考模式](./thinking-mode.md)）。
2. 思考模式下返回的 `reasoning_content` 默认不参与无工具调用的多轮拼接，传入会被 API 忽略。
