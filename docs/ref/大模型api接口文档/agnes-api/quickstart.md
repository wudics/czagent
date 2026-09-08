# 快速开始（Quickstart）

> 文档来源：https://wiki.agnes-ai.com/en/docs/quickstart.md

## 前置条件

- 拥有有效的 Agnes AI Platform 账号
- 在开发者仪表盘中生成有效的 API Key

## 步骤

### 1. 创建账号

注册新账号或登录已有 Agnes AI Platform 账号。在开发者仪表盘中可管理 API Key、计费等。

### 2. 生成 API Key

在 Agnes AI Platform 中生成密钥 API Key，用于所有 API 请求的身份认证：

```
Authorization: Bearer YOUR_API_KEY
```

### 3. 发送第一个请求

使用 `curl` 创建对话补全（也可使用 Postman、Python requests 或其他 HTTP 客户端）：

```bash
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
      "model": "agnes-2.0-flash",
      "messages": [
        {
          "role": "user",
          "content": "Hello!"
        }
      ]
    }'
```

> 请将 `YOUR_API_KEY` 替换为实际 API Key。成功的响应将返回与输入匹配的对话补全结果。

### 4. 下一步

- 阅读各 API 端点的请求参数、响应格式和错误处理文档
- 集成流式响应（streaming）或工具调用（tool calling）等高级功能
- 根据场景选择合适模型：文本模型（`agnes-2.5-flash` / `agnes-2.5-pro`）、图像模型（`agnes-image-2.1-flash`）、视频模型（`agnes-video-2.5`）

## Python 快速示例

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://apihub.agnes-ai.com/v1"
)

response = client.chat.completions.create(
    model="agnes-2.5-flash",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ]
)
print(response.choices[0].message.content)
```
