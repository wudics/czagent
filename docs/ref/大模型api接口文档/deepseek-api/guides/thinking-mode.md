# 思考模式

> 指南文档来源：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

## 概述

DeepSeek 模型支持思考模式：在输出最终回答之前，模型会先输出一段思维链（Chain-of-Thought）内容，以提升最终答案的准确性。

## 思考模式开关与思考强度控制

### 各 API 格式的控制参数

| 功能 | OpenAI 格式（Chat Completions） | Anthropic 格式 | Responses API 格式 |
|------|-------------------------------|----------------|-------------------|
| 思考模式开关 | `{"thinking": {"type": "enabled/disabled"}}` | `{"reasoning": {"effort": "none/low/high/max"}}`（`none` 表示关闭） | `{"reasoning": {"effort": "..."}}` |
| 思考强度控制 | `{"reasoning_effort": "low/high/max"}` | `{"output_config": {"effort": "low/high/max"}}` | 同 `reasoning.effort` |

> 思考模式**默认打开**，且 effort 默认为 `high`。

### effort 映射表

（`deepseek-v4-flash` 与 `deepseek-v4-pro` 一致）

| 请求传入 effort | 实际映射 effort |
|----------------|----------------|
| low | low |
| medium | high |
| high | high |
| xhigh | high |
| max | max |

### OpenAI SDK 中设置 thinking 参数

注意：在 OpenAI SDK 中使用 Chat Completion 设置 `thinking` 参数时，需将 `thinking` 参数传入 `extra_body` 中：

```python
response = client.chat.completions.create(
  model="deepseek-v4-pro",
  # ...
  reasoning_effort="high",
  extra_body={"thinking": {"type": "enabled"}}
)
```

## 输入输出参数

思考模式**不支持**以下参数：`temperature`、`top_p`、`presence_penalty`、`frequency_penalty`。

> 为兼容已有软件，设置这些参数不会报错，但也不会生效。

### 思维链的返回与拼接

- 思考模式下，思维链内容通过 `reasoning_content` 参数返回，与 `content` 同级
- **无工具调用**时：两个 `user` 消息之间的 `assistant` 的 `reasoning_content` 无需参与上下文拼接，后续轮次传入会被忽略
- **有工具调用**时：`assistant` 的 `reasoning_content` 必须参与上下文拼接，在所有后续 user 交互轮次中必须**回传给 API**，否则返回 400 错误

## 多轮对话拼接

在每一轮对话过程中，模型会输出思维链内容（`reasoning_content`）和最终回答（`content`）。如果没有工具调用，则下一轮对话中，之前轮输出的思维链内容不会拼接到上下文中。

### 非流式样例

```python
from openai import OpenAI

client = OpenAI(api_key="<DeepSeek API Key>", base_url="https://api.deepseek.com")

# Turn 1
messages = [{"role": "user", "content": "9.11 and 9.8, which is greater?"}]
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
)
reasoning_content = response.choices[0].message.reasoning_content
content = response.choices[0].message.content

# Turn 2
# reasoning_content 会被 API 忽略（无工具调用场景）
messages.append(response.choices[0].message)
messages.append({'role': 'user', 'content': "How many Rs are there in the word 'strawberry'?"})
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
)
```

### 流式样例

```python
from openai import OpenAI

client = OpenAI(api_key="<DeepSeek API Key>", base_url="https://api.deepseek.com")

messages = [{"role": "user", "content": "9.11 and 9.8, which is greater?"}]
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    stream=True,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
)

reasoning_content = ""
content = ""
for chunk in response:
    if chunk.choices[0].delta.reasoning_content:
        reasoning_content += chunk.choices[0].delta.reasoning_content
    else:
        content += chunk.choices[0].delta.content

# Turn 2
messages.append({"role": "assistant", "reasoning_content": reasoning_content, "content": content})
messages.append({'role': 'user', 'content': "How many Rs are there in the word 'strawberry'?"})
```

## 工具调用

DeepSeek 模型的思考模式支持工具调用功能，模型在输出最终答案之前，可以进行多轮的思考与工具调用，以提升答案质量。

> **重要**：携带了 `tools` 参数的请求，在后续所有请求中，必须完整回传 `reasoning_content` 给 API。若未正确回传，API 会返回 400 报错。

### 样例代码

```python
import os
import json
from openai import OpenAI
from datetime import datetime

# 工具定义
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_date",
            "description": "Get the current date",
            "parameters": { "type": "object", "properties": {} },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather of a location, the user should supply the location and date.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": { "type": "string", "description": "The city name" },
                    "date": { "type": "string", "description": "The date in format YYYY-mm-dd" },
                },
                "required": ["location", "date"]
            },
        }
    },
]

# 模拟工具实现
def get_date_mock():
    return datetime.now().strftime("%Y-%m-%d")

def get_weather_mock(location, date):
    return "Cloudy 7~13°C"

TOOL_CALL_MAP = {
    "get_date": get_date_mock,
    "get_weather": get_weather_mock,
}

def run_turn(turn, messages):
    sub_turn = 1
    while True:
        response = client.chat.completions.create(
            model='deepseek-v4-pro',
            messages=messages,
            tools=tools,
            reasoning_effort="high",
            extra_body={"thinking": {"type": "enabled"}},
        )
        messages.append(response.choices[0].message)
        reasoning_content = response.choices[0].message.reasoning_content
        content = response.choices[0].message.content
        tool_calls = response.choices[0].message.tool_calls

        print(f"Turn {turn}.{sub_turn}\n{reasoning_content=}\n{content=}\n{tool_calls=}")

        if tool_calls is None:
            break

        for tool in tool_calls:
            tool_function = TOOL_CALL_MAP[tool.function.name]
            tool_result = tool_function(**json.loads(tool.function.arguments))
            print(f"tool result for {tool.function.name}: {tool_result}\n")
            messages.append({
                "role": "tool",
                "tool_call_id": tool.id,
                "content": tool_result,
            })
        sub_turn += 1
    print()

client = OpenAI(
    api_key=os.environ.get('DEEPSEEK_API_KEY'),
    base_url=os.environ.get('DEEPSEEK_BASE_URL'),
)

# 用户发起第一轮问题
turn = 1
messages = [{"role": "user", "content": "How's the weather in Hangzhou Tomorrow"}]
run_turn(turn, messages)

# 用户发起第二轮问题（携带前一轮的 reasoning_content）
turn = 2
messages.append({"role": "user", "content": "How's the weather in Guangzhou Tomorrow"})
run_turn(turn, messages)
```

> 说明：`messages.append(response.choices[0].message)` 会将 `assistant` 消息的所有必要字段（`content`、`reasoning_content`、`tool_calls`）追加到 messages 中，等价于手动拼接三个字段。
