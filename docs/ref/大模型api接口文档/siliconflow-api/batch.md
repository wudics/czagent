# Batch 模块（批量任务）

> 接口文档来源：
> - https://api-docs.siliconflow.cn/docs/api/files-get
> - https://api-docs.siliconflow.cn/docs/api/files-post
> - https://api-docs.siliconflow.cn/docs/api/batches-get
> - https://api-docs.siliconflow.cn/docs/api/batches-post
> - https://api-docs.siliconflow.cn/docs/api/batches-{batch_id}-get
> - https://api-docs.siliconflow.cn/docs/api/batches-{batch_id}-cancel-post

---

## 一、Upload Files（上传文件）

### 接口信息

- **方法**: POST
- **路径**: `/v1/files`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

上传文件，用于创建批量任务（Batch Job）。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `purpose` | string | ✅ | 固定为 `batch` |
| `file` | file | ✅ | 上传的文件（JSONL 格式，binary） |

### 响应格式（200 OK）

```json
{
  "code": 20000,
  "message": "Ok",
  "status": true,
  "data": {
    "id": "file-jkvytbjtow",
    "object": "file",
    "bytes": 8509,
    "createdAt": 1741685396,
    "filename": "requests.jsonl",
    "purpose": "batch"
  }
}
```

### 调用示例

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/files \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --form purpose=batch \
  --form 'file=@files_example.jsonl'
```

```python
import requests

url = "https://api.siliconflow.cn/v1/files"
headers = {"Authorization": "Bearer YOUR_API_KEY"}
with open("files_example.jsonl", "rb") as f:
    files = {"file": ("files_example.jsonl", f)}
    data = {"purpose": "batch"}
    response = requests.post(url, headers=headers, data=data, files=files)
    print(response.json())
```

---

## 二、List Files（列出文件）

### 接口信息

- **方法**: GET
- **路径**: `/v1/files`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

返回文件列表。

---

## 三、Create a Batch（创建批次任务）

### 接口信息

- **方法**: POST
- **路径**: `/v1/batches`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

创建批量任务，用于异步处理大量请求。

### 请求参数（Body）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `input_file_id` | string | ✅ | 已上传文件的 ID，包含新批次的请求 |
| `endpoint` | string | ✅ | 批次中所有请求使用的端点，当前支持 `/v1/chat/completions` |
| `completion_window` | string | ✅ | 批次处理时间窗口，最小 24 小时，最大 336 小时（如 `"24h"`） |
| `metadata` | object | ❌ | 16 个键值对，键 ≤ 64 字符，值 ≤ 512 字符 |
| `replace` | object | ❌ | 替换参数（如替换 model） |

### 响应格式（200 OK）

```json
{
  "id": "batch_rdyqgrcgjg",
  "object": "batch",
  "endpoint": "/v1/chat/completions",
  "errors": null,
  "input_file_id": "file-jkvytbjtow",
  "completion_window": "24h",
  "status": "in_queue",
  "output_file_id": null,
  "error_file_id": null,
  "created_at": 1741685413,
  "in_progress_at": null,
  "expires_at": 1741771813,
  "finalizing_at": null,
  "completed_at": null,
  "failed_at": null,
  "expired_at": null,
  "cancelling_at": null,
  "cancelled_at": null,
  "request_counts": null,
  "metadata": {
    "description": "nightly eval job"
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `id` | 批次 ID，如 `batch_rdyqgrcgjg` |
| `status` | 状态：`in_queue` / 处理中 / 已完成等 |
| `output_file_id` | 输出文件 ID（完成后） |
| `error_file_id` | 错误文件 ID |
| `request_counts` | 请求统计 |

### 调用示例

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/batches \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "input_file_id": "file-jkvytbjtow",
    "endpoint": "/v1/chat/completions",
    "completion_window": "24h",
    "metadata": {"description": "nightly eval job"},
    "replace": {"model": "deepseek-ai/DeepSeek-V3"}
  }'
```

---

## 四、List Batches（列出批次任务）

### 接口信息

- **方法**: GET
- **路径**: `/v1/batches`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

列出组织的批次任务。

### 查询参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `limit` | integer | 返回对象数量上限，≥ 1 |
| `after` | string | 分页游标（对象 ID），用于获取下一页 |

### 响应格式（200 OK）

```json
{
  "object": "list",
  "data": [
    {
      "id": "batch_id",
      "object": "batch",
      "endpoint": "/v1/chat/completions",
      "errors": null,
      "input_file_id": "file-id",
      "completion_window": "24h",
      "status": "in_queue",
      "created_at": 1749023566,
      "metadata": {
        "batch_description": "",
        "name": "batch"
      },
      "file_name": "requests_name.json"
    }
  ],
  "first_id": "first_batch_id",
  "last_id": "last_batch_id",
  "has_more": false
}
```

---

## 五、Retrieves a Batch（查询批次状态）

### 接口信息

- **方法**: GET
- **路径**: `/v1/batches/{batch_id}`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

通过批次 ID 检索批次信息。

### 路径参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `batch_id` | string | 批次 ID |

---

## 六、Cancel a Batch（取消批次任务）

### 接口信息

- **方法**: POST
- **路径**: `/v1/batches/{batch_id}/cancel`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

通过批次 ID 取消批次任务。

### 路径参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `batch_id` | string | 批次 ID |

---

## 错误响应示例（通用）

| 状态码 | 示例响应 |
|--------|----------|
| 400 | `{"code": 20012, "message": "string", "data": "string"}` |
| 401 | `"Invalid token"` |
| 403 | `"Forbidden"` |
| 404 | `"404 page not found"` |
| 503 | `{"code": 50505, "message": "Model service overloaded. Please try again later.", "data": "string"}` |
| 504 | `"string"` |
