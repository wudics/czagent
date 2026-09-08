# Create a Embedding

> 接口文档来源：https://api-docs.siliconflow.cn/docs/api/embeddings-post

## 接口信息

- **方法**: POST
- **路径**: `/v1/embeddings`
- **认证**: `Authorization: Bearer {API_KEY}`
- **Content-Type**: `application/json`

## 概述

将输入内容转换为 Embedding 向量。支持文本、图片 URL/base64 及混合列表（VL Embedding 模型）。

## 请求参数（Body）

### 经典 Embedding（文本）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，如 `BAAI/bge-large-zh-v1.5`。完整列表见 [Models](https://cloud.siliconflow.cn/models?types=embedding) |
| `input` | string\|array | ✅ | 输入文本（字符串或 token 数组，支持批量传入）。不可为空字符串 |
| `encoding_format` | string | ❌ | 返回格式：`float` / `base64`，默认 `float` |
| `dimensions` | integer | ❌ | 输出向量维度（仅 Qwen/Qwen3 系列支持） |
| `user` | string | ❌ | 用户标识，用于请求追踪和限流 |
| `truncate` | string | ❌ | 超长文本截断方向：`left` / `right` |

### 各模型最大输入 token

| 模型 | 最大输入 tokens |
|------|----------------|
| BAAI/bge-large-zh-v1.5 | 512 |
| BAAI/bge-large-en-v1.5 | 512 |
| netease-youdao/bce-embedding-base_v1 | 512 |
| BAAI/bge-m3、Pro/BAAI/bge-m3 | 8192 |
| Qwen/Qwen3-Embedding-8B | 32768 |
| Qwen/Qwen3-Embedding-4B | 32768 |
| Qwen/Qwen3-Embedding-0.6B | 32768 |

### dimensions 支持范围（Qwen3 系列）

| 模型 | 支持维度 |
|------|----------|
| Qwen/Qwen3-Embedding-8B | [64, 128, 256, 512, 768, 1024, 1536, 2048, 2560, 4096] |
| Qwen/Qwen3-Embedding-4B | [64, 128, 256, 512, 768, 1024, 1536, 2048, 2560] |
| Qwen/Qwen3-Embedding-0.6B | [64, 128, 256, 512, 768, 1024] |

### VL Embedding（多模态）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，支持 `Qwen/Qwen3-VL-Embedding-8B` |
| `input` | string\|object\|array | ✅ | 输入内容，支持纯字符串、内容对象、混合列表 |
| `encoding_format` | string | ❌ | `float` / `base64`，默认 `float` |
| `dimensions` | integer | ❌ | 输出维度（仅 Qwen3 系列） |

**input 内容对象格式：**
- 文本对象：`{"text": "text to embed"}`
- 图片对象：`{"image": "https://example.com/image.jpg"}` 或 base64
- 混合列表：`["First text", {"text": "Second text"}, {"image": "https://example.com/image.jpg"}]`

> 暂不支持视频内容。

## 响应格式（200 OK）

```json
{
  "object": "list",
  "model": "string",
  "data": [
    {
      "object": "embedding",
      "embedding": [0],
      "index": 0
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `object` | 恒为 `list` |
| `model` | 生成 embedding 的模型名称 |
| `data[].embedding` | 向量数据 |
| `data[].index` | 输入列表中的索引 |
| `usage` | token 用量信息 |

## 调用示例

### cURL（文本）

```bash
curl -X POST https://api.siliconflow.cn/v1/embeddings \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Hello, world!",
    "model": "BAAI/bge-large-zh-v1.5"
  }'
```

### cURL（VL Embedding）

```bash
curl -X POST https://api.siliconflow.cn/v1/embeddings \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": [
      "First text",
      {"text": "Second text"},
      {"image": "https://example.com/image.jpg"}
    ],
    "model": "Qwen/Qwen3-VL-Embedding-8B",
    "dimensions": 768
  }'
```

### Python（图片输入）

```python
import requests

response = requests.post(
    "https://api.siliconflow.cn/v1/embeddings",
    headers={
        "Authorization": "Bearer $SILICONFLOW_API_KEY",
        "Content-Type": "application/json"
    },
    json={
        "input": {"image": "https://example.com/image.jpg"},
        "model": "Qwen/Qwen3-VL-Embedding-8B"
    }
)
print(response.json())
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
