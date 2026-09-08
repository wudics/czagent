# Video 模块（视频生成）

> 接口文档来源：
> - https://api-docs.siliconflow.cn/docs/api/video-submit-post
> - https://api-docs.siliconflow.cn/docs/api/video-status-post

---

## 一、Submit a Video（提交视频生成任务）

### 接口信息

- **方法**: POST
- **路径**: `/v1/video/submit`
- **认证**: `Authorization: Bearer {API_KEY}`
- **Content-Type**: `application/json`

### 概述

通过输入提示词生成视频。此 API 返回用户当前请求 ID，用户需轮询状态接口获取视频链接。

> **注意**：生成结果**有效期为 10 分钟**，请及时获取视频链接。

### 请求参数（Body）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称：`Wan-AI/Wan2.2-I2V-A14B`（图生视频）/ `Wan-AI/Wan2.2-T2V-A14B`（文生视频）。完整列表见 [Models](https://cloud.siliconflow.cn/models?types=to-video) |
| `prompt` | string | ✅ | 视频生成提示词 |
| `negative_prompt` | string | ❌ | 反向提示词 |
| `image_size` | string | ✅ | 生成图像的长宽比：`1280x720` / `720x1280` / `960x960` |
| `image` | string | ❌ | 输入图片（base64 或 URL），选择 I2V 模型时**必填** |
| `seed` | integer | ❌ | 随机数生成器种子 |

### 响应格式（200 OK）

```json
{
  "requestId": "string"
}
```

`requestId`：本次请求生成的 ID，调用状态接口时需要用到。

### 调用示例

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/video/submit \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "Wan-AI/Wan2.2-I2V-A14B",
    "prompt": "A cat running on grass",
    "image_size": "1280x720",
    "image": "https://inews.gtimg.com/om_bt/Os3eJ8u3SgB3Kd-zrRRhgfR5hUvdwcVPKUTNO6O7sZfUwAA/641"
  }'
```

```python
import requests

url = "https://api.siliconflow.cn/v1/video/submit"
payload = {
    "model": "Wan-AI/Wan2.2-I2V-A14B",
    "prompt": "A cat running on grass",
    "image_size": "1280x720",
    "image": "https://inews.gtimg.com/om_bt/Os3eJ8u3SgB3Kd-zrRRhgfR5hUvdwcVPKUTNO6O7sZfUwAA/641"
}
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

response = requests.post(url, json=payload, headers=headers)
print(response.text)
```

---

## 二、List a Video（查询视频生成状态）

### 接口信息

- **方法**: POST
- **路径**: `/v1/video/status`
- **认证**: `Authorization: Bearer {API_KEY}`

### 概述

获取用户生成的视频（通过提交任务时返回的 requestId 查询）。

> **注意**：生成的视频 URL 有效期为 **1 小时**，请及时下载保存。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | string | ✅ | 提交视频生成任务时返回的请求 ID |

### 响应格式（200 OK）

```json
{
  "requestId": "string",
  "status": "string",
  "videos": [
    {
      "url": "string"
    }
  ],
  "images": [
    {
      "url": "string"
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `requestId` | 请求 ID |
| `status` | 生成状态（如生成中 / 已完成等） |
| `videos[].url` | 生成的视频 URL（1 小时内有效） |
| `images[].url` | 生成的图片 URL |

---

## 错误响应示例（通用）

| 状态码 | 示例响应 |
|--------|----------|
| 400 | `{"code": 20012, "message": "string", "data": "string"}` |
| 401 | `"Invalid token"` |
| 403 | `"Forbidden"` |
| 404 | `"404 page not found"` |
| 429 | `{"message": "Request was rejected due to rate limiting...", "data": "string"}` |
| 503 | `{"code": 50505, "message": "Model service overloaded. Please try again later.", "data": "string"}` |
| 504 | `"string"` |
