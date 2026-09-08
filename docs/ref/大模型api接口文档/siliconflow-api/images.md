# Image Generation（图像生成）

> 接口文档来源：https://api-docs.siliconflow.cn/docs/api/images-generations-post

## 接口信息

- **方法**: POST
- **路径**: `/v1/images/generations`
- **认证**: `Authorization: Bearer {API_KEY}`
- **Content-Type**: `application/json`

## 概述

根据提示词生成图像，支持文生图（T2I）和图生图（I2I）。

> **注意**：生成的图片 URL 有效期仅为 **1 小时**，请及时下载保存。

## 请求参数（Body）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，如 `Qwen/Qwen-Image-Edit-2509`。完整列表见 [Models](https://cloud.siliconflow.cn/models?types=to-image) |
| `prompt` | string | ✅ | 图像生成提示词 |
| `negative_prompt` | string | ❌ | 反向提示词 |
| `image_size` | string | ❌ | 图像分辨率，格式 `[width]x[height]`（Qwen-Image-Edit 系列不支持） |
| `batch_size` | integer | ❌ | 输出图像数量，范围 [1, 4]，默认 1（仅 Kwai-Kolors/Kolors 适用） |
| `seed` | integer | ❌ | 随机种子，≤ 9999999999 |
| `num_inference_steps` | integer | ❌ | 推理步数，范围 [1, 100]，默认 20 |
| `guidance_scale` | number | ❌ | 提示词匹配度控制，默认 7.5，≤ 20（仅 Kwai-Kolors/Kolors） |
| `cfg` | number | ❌ | CFG Scale，范围 [0.1, 20]（仅 Qwen/Qwen-Image 系列） |
| `image` | string | ❌ | 上传图片（base64 或 URL），用于图生图 |
| `image2` | string | ❌ | 第二张图片（仅 Qwen/Qwen-Image-Edit-2509） |
| `image3` | string | ❌ | 第三张图片（仅 Qwen/Qwen-Image-Edit-2509） |

### image_size 推荐值

**Kolor 模型：**

| 尺寸 | 比例 |
|------|------|
| 1024x1024 | 1:1 |
| 960x1280 | 3:4 |
| 768x1024 | 3:4 |
| 720x1440 | 1:2 |
| 720x1280 | 9:16 |

**Qwen-Image 模型：**

| 尺寸 | 比例 |
|------|------|
| 1328x1328 | 1:1 |
| 1664x928 | 16:9 |
| 928x1664 | 9:16 |
| 1472x1140 | 4:3 |
| 1140x1472 | 3:4 |
| 1584x1056 | 3:2 |
| 1056x1584 | 2:3 |

> image 上传格式：`"data:image/png;base64, XXX"` 或 `"img_url"`

## 响应格式（200 OK）

```json
{
  "images": [
    {
      "url": "string"
    }
  ],
  "timings": {
    "inference": 0.1
  },
  "seed": 0
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `images[].url` | 生成的图片 URL（1 小时内有效） |
| `timings.inference` | 推理耗时 |
| `seed` | 使用的随机种子 |

## 调用示例

### cURL（文生图）

```bash
curl --request POST \
  --url https://api.siliconflow.cn/v1/images/generations \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "Kwai-Kolors/Kolors",
    "prompt": "an island near sea, with seagulls, moon shining over the sea, light house, boats in the background, fish flying over the sea",
    "image_size": "1024x1024",
    "batch_size": 1,
    "num_inference_steps": 20,
    "guidance_scale": 7.5
  }'
```

### Python（图生图）

```python
import requests

url = "https://api.siliconflow.cn/v1/images/generations"
payload = {
    "model": "Kwai-Kolors/Kolors",
    "prompt": "an island near sea, with seagulls, moon shining over the sea, light house, boats in the background, fish flying over the sea",
    "image_size": "1024x1024",
    "batch_size": 1,
    "num_inference_steps": 20,
    "guidance_scale": 7.5,
    "image": "https://inews.gtimg.com/om_bt/Os3eJ8u3SgB3Kd-zrRRhgfR5hUvdwcVPKUTNO6O7sZfUwAA/641"
}
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}
response = requests.post(url, json=payload, headers=headers)
print(response.text)
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
