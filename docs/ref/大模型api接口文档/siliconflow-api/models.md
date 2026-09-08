# List Models（列出模型）

> 接口文档来源：https://api-docs.siliconflow.cn/docs/api/models-get

## 接口信息

- **方法**: GET
- **路径**: `/v1/models`
- **认证**: `Authorization: Bearer {API_KEY}`

## 概述

检索平台可用模型的信息。

## 查询参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | ❌ | 模型类型：`text` / `image` / `audio` / `video` |
| `sub_type` | string | ❌ | 模型子类型：`chat` / `embedding` / `reranker` / `text-to-image` / `image-to-image` / `speech-to-text` / `text-to-video`（可不设置 type 单独使用） |

## 响应格式（200 OK）

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-ai/DeepSeek-V4-Flash",
      "object": "model",
      "created": 0,
      "owned_by": ""
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `object` | 恒为 `list` |
| `data[].id` | 模型 ID，如 `deepseek-ai/DeepSeek-V4-Flash` |
| `data[].object` | 恒为 `model` |
| `data[].created` | 创建时间戳 |
| `data[].owned_by` | 模型所属组织 |

## 调用示例

### cURL

```bash
# 列出所有 chat 模型
curl --request GET \
  --url 'https://api.siliconflow.cn/v1/models?sub_type=chat' \
  --header 'Authorization: Bearer YOUR_API_KEY'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://api.siliconflow.cn/v1"
)

models = client.models.list()
for m in models.data:
    print(m.id)
```

## 错误响应示例

| 状态码 | 示例响应 |
|--------|----------|
| 400 | `{"code": 20012, "message": "string", "data": "string"}` |
| 401 | `"Invalid token"` |
| 403 | `"Forbidden"` |
| 404 | `"404 page not found"` |
| 429 | `{"message": "Request was rejected due to rate limiting...", "data": "string"}` |
| 503 | `{"code": 50505, "message": "Model service overloaded. Please try again later.", "data": "string"}` |
| 504 | `"string"` |
