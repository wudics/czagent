# JSON Output

> 指南文档来源：https://api-docs.deepseek.com/zh-cn/guides/json_mode

## 概述

在很多场景下，用户需要让模型严格按照 JSON 格式来输出，以实现输出的结构化，便于后续逻辑进行解析。DeepSeek 提供了 JSON Output 功能，确保模型输出合法的 JSON 字符串。

## 使用注意事项

1. 设置 `response_format` 参数为 `{'type': 'json_object'}`
2. 用户传入的 system 或 user prompt 中**必须含有 `json` 字样**，并给出希望模型输出的 JSON 格式的样例，以指导模型输出合法 JSON
3. 需要合理设置 `max_tokens` 参数，防止 JSON 字符串被中途截断
4. **在使用 JSON Output 功能时，API 有概率会返回空的 content**（官方正在积极优化该问题，可尝试修改 prompt 缓解）

## 样例代码

```python
import json
from openai import OpenAI

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com",
)

system_prompt = """The user will provide some exam text. Please parse the "question" and "answer" and output them in JSON format.
EXAMPLE INPUT: Which is the highest mountain in the world? Mount Everest.
EXAMPLE JSON OUTPUT:
{
    "question": "Which is the highest mountain in the world?",
    "answer": "Mount Everest"
}"""

user_prompt = "Which is the longest river in the world? The Nile River."
messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": user_prompt}
]

response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    response_format={
        'type': 'json_object'
    }
)

print(json.loads(response.choices[0].message.content))
```

### 模型输出示例

```json
{
    "question": "Which is the longest river in the world?",
    "answer": "The Nile River"
}
```

## 关键点总结

| 要点 | 说明 |
|------|------|
| `response_format` | 必须设置为 `{"type": "json_object"}` |
| prompt 要求 | 必须包含 `json` 字样和输出格式样例 |
| `max_tokens` | 需合理设置，防止 JSON 被截断 |
| 截断信号 | 若 `finish_reason="length"`，表示生成超过限制，内容可能被部分截断 |
