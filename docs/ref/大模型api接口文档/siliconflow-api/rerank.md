# Create a Rerank

> 接口文档来源：https://api-docs.siliconflow.cn/docs/api/rerank-post

## 接口信息

- **方法**: POST
- **路径**: `/v1/rerank`
- **认证**: `Authorization: Bearer {API_KEY}`
- **Content-Type**: `application/json`

## 概述

根据查询（query）与文档的相关性对文档进行重排。支持文本、图片和视频内容（VL Rerank 模型）。

## 请求参数（Body）

### 经典 Rerank（文本）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，如 `BAAI/bge-reranker-v2-m3`。完整列表见 [Models](https://cloud.siliconflow.cn/models?types=rerank) |
| `query` | string | ✅ | 搜索查询，长度 ≥ 1 |
| `documents` | string\|array | ✅ | 待排序文档列表，至少 1 个文档 |
| `instruction` | string | ❌ | 重排指令，仅 Qwen/Qwen3-Reranker 系列支持，长度 ≥ 1 |
| `top_n` | integer | ❌ | 返回最相关文档数量，≥ 1 |
| `return_documents` | boolean | ❌ | 是否在响应中包含文档文本，默认 `false` |
| `max_chunks_per_doc` | integer | ❌ | 文档分块最大数量，默认 1024，≥ 1（仅 bge-reranker-v2-m3、bce-reranker-base_v1 支持） |
| `overlap_tokens` | integer | ❌ | 相邻分块间的 token 重叠数，范围 ≤ 80（同上） |

### VL Rerank（多模态）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，支持 `Qwen/Qwen3-VL-Reranker-8B` |
| `query` | string\|object | ✅ | 文本查询或图片对象 `{"image": "..."}` |
| `documents` | array | ✅ | 文档列表，每项可为文本字符串或内容对象 |
| `instruction` | string | ❌ | 重排指令 |
| `top_n` | integer | ❌ | 返回数量，≥ 1 |
| `return_documents` | boolean | ❌ | 是否返回文档文本，默认 `false` |
| `max_chunks_per_doc` | integer | ❌ | 默认 1024，≥ 1 |
| `overlap_tokens` | integer | ❌ | 范围 ≤ 80 |

**query 支持格式：**
- 文本：纯字符串
- 图片：`{"image": "https://example.com/image.jpg"}` 或 base64

**documents 支持格式：**
- 文本文档：纯字符串
- 文本对象：`{"text": "document text"}`
- 图片对象：`{"image": "https://example.com/image.jpg"}` 或 base64

## 响应格式（200 OK）

```json
{
  "id": "rerank-20240115-abc123def456",
  "results": [
    {
      "index": 1,
      "document": {
        "text": "深度学习是机器学习的子集..."
      },
      "relevance_score": 0.85
    }
  ],
  "meta": {
    "tokens": {
      "input_tokens": 150,
      "output_tokens": 10,
      "image_tokens": 0
    },
    "billed_units": {
      "input_tokens": 150,
      "output_tokens": 10,
      "image_tokens": 0,
      "search_units": 1,
      "classifications": 0
    }
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `id` | 响应唯一标识符 |
| `results[].index` | 文档在原列表中的索引（按相关性排序） |
| `results[].document` | 文档内容（`return_documents=true` 时返回） |
| `results[].relevance_score` | 相关性分数 |
| `meta.tokens` | token 用量明细 |
| `meta.billed_units` | 计费单位明细 |

## 调用示例

### cURL（文本）

```bash
curl -X POST https://api.siliconflow.cn/v1/rerank \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "BAAI/bge-reranker-v2-m3",
    "query": "Apple",
    "documents": ["apple", "banana", "fruit", "vegetable"],
    "return_documents": true,
    "top_n": 4
  }'
```

### cURL（带指令）

```bash
curl -X POST https://api.siliconflow.cn/v1/rerank \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3-Reranker-8B",
    "query": "Find the most relevant technical docs",
    "documents": ["doc1", "doc2", "doc3"],
    "instruction": "Prefer recently published content",
    "overlap_tokens": 20
  }'
```

### Python（VL 图片重排）

```python
import os
import requests

url = "https://api.siliconflow.cn/v1/rerank"
headers = {
    "Authorization": f"Bearer {os.environ.get('SILICONFLOW_API_KEY')}",
    "Content-Type": "application/json"
}
payload = {
    "model": "Qwen/Qwen3-VL-Reranker-8B",
    "query": {"image": "https://example.com/query-image.jpg"},
    "documents": [
        {"image": "https://example.com/doc1.jpg"},
        "A relevant text document..."
    ],
    "max_chunks_per_doc": 512
}

response = requests.post(url, json=payload, headers=headers)
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
