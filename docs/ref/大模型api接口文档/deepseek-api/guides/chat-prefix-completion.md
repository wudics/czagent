# 对话前缀续写（Beta）

> 指南文档来源：https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion

## 概述

对话前缀续写沿用 [Chat Completion API](../chat-completions.md)，用户提供 `assistant` 开头的消息，来让模型补全其余的消息。

## 使用注意事项

1. 使用对话前缀续写时，用户需确保 `messages` 列表里**最后一条消息的 `role` 为 `assistant`**，并设置最后一条消息的 `prefix` 参数为 `True`
2. 用户需要设置 `base_url="https://api.deepseek.com/beta"` 来开启 Beta 功能

## 样例代码

下面的例子中，设置 `assistant` 开头的消息为 `"```python\n"` 来强制模型输出 python 代码，并设置 `stop` 参数为 `['```']` 来避免模型的额外解释。

```python
from openai import OpenAI

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com/beta",
)

messages = [
    {"role": "user", "content": "Please write quick sort code"},
    {"role": "assistant", "content": "```python\n", "prefix": True}
]

response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    stop=["```"],
)

print(response.choices[0].message.content)
```

## 相关参数

在 [Chat Completions API](../chat-completions.md) 的 `assistant` 消息中：

| 参数 | 类型 | 说明 |
|------|------|------|
| `prefix` | bool | 设置为 `true`，强制模型在回答中以此 assistant 消息中提供的前缀内容开始（需 `base_url="https://api.deepseek.com/beta"`） |
| `reasoning_content` | string | (Beta) 思考模式下，作为最后一条 assistant 思维链内容的输入；使用此功能时 `prefix` 必须为 `true` |
