# 视频模型（Video Models）

> 文档来源：
> - https://wiki.agnes-ai.com/en/docs/agnes-video-v20.md
> - https://wiki.agnes-ai.com/en/docs/agnes-video-v25.md

## 模型总览

| 模型 ID | 说明 | 支持模式 |
|---------|------|----------|
| `agnes-video-v2.0` | 异步视频生成模型 | 文生视频、图生视频、关键帧动画 |
| `agnes-video-2.5` | 新版异步视频生成模型 | 文生视频、首尾帧控制、多模态参考 |

> 视频生成采用**异步任务 API**：先创建任务，再通过 `video_id` 或 `task_id` 轮询获取结果。

### 价格

**agnes-video-v2.0：**

| 类型 | 标准价格 | 当前价格 |
|------|----------|----------|
| 视频时长 | $0.005 / 秒 | $0 / 秒 |

**agnes-video-2.5（720P）：**

| 输出分辨率 | 标价 |
|-----------|------|
| 720P | $0.025 / 秒 |

> 当前促销：仅按输出视频时长计费，输入视频时长和参考图片暂时免费。

---

## 一、Agnes Video V2.0

### 接口信息

| 操作 | 端点 |
|------|------|
| 创建视频任务 | `POST https://apihub.agnes-ai.com/v1/videos` |
| 查询结果（推荐） | `GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>` |
| 查询结果（旧版兼容） | `GET https://apihub.agnes-ai.com/v1/videos/<TASK_ID>` |

### 创建任务参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称，使用 `agnes-video-v2.0` |
| `prompt` | string | ✅ | 视频内容文本描述 |
| `image` | string | ❌ | 图生视频的图片 URL |
| `mode` | string | ❌ | 生成模式，如 `ti2vid` 或 `keyframes` |
| `height` | integer | ❌ | 视频高度，默认 `768` |
| `width` | integer | ❌ | 视频宽度，默认 `1152` |
| `num_frames` | integer | ❌ | 帧数，必须 `<= 441` 且遵循 `8n + 1` 规则 |
| `frame_rate` | number | ❌ | 帧率，支持范围 `1-60` |
| `num_inference_steps` | integer | ❌ | 推理步数 |
| `seed` | integer | ❌ | 随机种子，用于复现结果 |
| `negative_prompt` | string | ❌ | 反向提示词，描述要避免的内容 |
| `extra_body.image` | array | ❌ | 关键帧工作流的输入图片 URL 数组 |
| `extra_body.mode` | string | ❌ | 附加模式设置，如 `keyframes` |

### 参数归一化

系统会归一化部分视频生成参数以确保输出质量稳定。当提交的 `width`、`height` 或宽高比不完全匹配模型规格时，系统将映射到最接近的标准输出配置。

模型支持三个标准分辨率档位：`480p`、`720p`、`1080p`。

**支持宽高比：**

| 宽高比 | 推荐用途 |
|--------|----------|
| `16:9` | 横屏视频、产品演示、YouTube 风格内容 |
| `9:16` | 竖屏短视频、移动优先内容、TikTok / Reels / Shorts |
| `1:1` | 方形视频、社交媒体信息流 |
| `4:3` | 传统横屏格式和通用演示内容 |
| `3:4` | 竖屏演示视频、人像内容 |

> **注意**：请求中的原始 `width`、`height`、`num_frames` 值可能与归一化后的生成设置不完全一致。展示任务信息、计算视频时长或调试时，请以 API 响应返回的 `size`、`seconds` 和 `metadata.size_mapping` 字段为准。

### 创建任务示例

**文生视频：**

```bash
curl -X POST https://apihub.agnes-ai.com/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "A cinematic shot of a cat walking on the beach at sunset, soft ocean waves, warm golden lighting, realistic motion",
    "height": 768,
    "width": 1152,
    "num_frames": 121,
    "frame_rate": 24
  }'
```

**图生视频：**

```bash
curl -X POST https://apihub.agnes-ai.com/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "The woman slowly turns around and looks back at the camera, natural facial expression, cinematic camera movement",
    "image": "https://example.com/image.png",
    "num_frames": 121,
    "frame_rate": 24
  }'
```

**关键帧动画：**

```bash
curl -X POST https://apihub.agnes-ai.com/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "Generate a smooth cinematic transition between the keyframes, maintaining visual consistency and natural camera movement",
    "extra_body": {
      "image": [
        "https://example.com/keyframe1.png",
        "https://example.com/keyframe2.png"
      ],
      "mode": "keyframes"
    },
    "num_frames": 121,
    "frame_rate": 24
  }'
```

### 创建任务响应

```json
{
  "id": "task_YOUR_TASK_ID",
  "task_id": "task_YOUR_TASK_ID",
  "video_id": "video_YOUR_VIDEO_ID",
  "object": "video",
  "model": "agnes-video-v2.0",
  "status": "queued",
  "progress": 0,
  "created_at": 1780457477,
  "seconds": "10.0",
  "size": "1280x768"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务 ID（可用于旧版查询端点） |
| `task_id` | string | 任务 ID，与 `id` 用途相同 |
| `video_id` | string | 视频 ID，推荐用于获取视频结果 |
| `object` | string | 对象类型，通常为 `video` |
| `model` | string | 任务使用的模型 |
| `status` | string | 当前任务状态 |
| `progress` | integer | 任务进度百分比 |
| `created_at` | integer | 任务创建时间戳 |
| `seconds` | string | 视频时长（秒） |
| `size` | string | 视频分辨率 |

### 查询视频结果

```bash
# 按 video_id 查询（推荐）
curl --location --request GET 'https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>' \
  --header 'Authorization: Bearer <API_KEY>'

# 按 video_id + model_name 查询
curl --location --request GET 'https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>&model_name=agnes-video-v2.0' \
  --header 'Authorization: Bearer <API_KEY>'

# 旧版：按 task_id 查询
curl --location --request GET 'https://apihub.agnes-ai.com/v1/videos/<TASK_ID>' \
  --header 'Authorization: Bearer <API_KEY>'
```

> 使用 `model_name` 的场景：使用上游原始视频 ID、模型不是默认的 `agnes-video-v2.0`、或需显式指定查询模型。

### 最终结果响应

```json
{
  "id": "task_YOUR_TASK_ID",
  "video_id": "task_YOUR_TASK_ID",
  "task_id": "task_YOUR_TASK_ID",
  "object": "video",
  "model": "agnes-video-v2.0",
  "status": "completed",
  "progress": 100,
  "created_at": 1784530473,
  "completed_at": 1784530510,
  "seconds": "1.0",
  "size": "832x448",
  "metadata": {
    "size_mapping": {
      "adjusted": true,
      "height": 448,
      "message": "Input size 1024x576 was mapped to nearest preset 480p/16:9 (832x448)",
      "ratio": "16:9",
      "requested_height": 576,
      "requested_width": 1024,
      "resolution": "480p",
      "width": 832
    },
    "url": "https://platform-outputs.agnes-ai.space/videos/agnes-video-v2.0/task_YOUR_TASK_ID.mp4"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | 任务状态 |
| `metadata.url` | string | 最终生成的视频 URL（`status` 为 `completed` 时可用） |
| `metadata.size_mapping` | object | 尺寸归一化详情（请求尺寸、实际输出尺寸、宽高比、分辨率档位） |
| `error` | object / null | 任务失败时的错误信息 |

### 任务状态

| 状态 | 说明 |
|------|------|
| `queued` | 任务在队列中等待 |
| `in_progress` | 视频生成中 |
| `completed` | 视频生成成功 |
| `failed` | 视频生成任务失败 |

### 视频时长控制

```text
seconds = num_frames / frame_rate
```

- `num_frames` ≤ 441，且遵循 `8n + 1` 规则
- `frame_rate` 支持 1-60

**常用时长设置：**

| 目标时长 | 推荐参数 |
|----------|----------|
| 约 3 秒 | `num_frames: 81`、`frame_rate: 24` |
| 约 5 秒 | `num_frames: 121`、`frame_rate: 24` |
| 约 10 秒 | `num_frames: 241`、`frame_rate: 24` |
| 约 18 秒 | `num_frames: 441`、`frame_rate: 24` |

### 错误码（Video V2.0）

| 状态码 | 说明 |
|--------|------|
| 400 | 无效请求，检查请求参数 |
| 401 | 未授权，检查 API Key |
| 404 | 任务或视频不存在 |
| 500 | 服务器错误 |
| 503 | 服务繁忙，稍后重试 |

---

## 二、Agnes Video 2.5

### 接口信息

| 操作 | 端点 |
|------|------|
| 创建视频任务 | `POST https://apihub.agnes-ai.com/v1/videos` |
| 查询任务 | `GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>` |

### 通用请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型 ID，使用 `agnes-video-2.5` |
| `prompt` | string | ✅ | 视频描述。参考模式下使用 `<Picture N>`、`<Audio N>`、`<Video N>` 引用输入媒体 |
| `mode` | string | ✅ | 生成模式：`text` / `keyframe` / `reference` |
| `seconds` | string | ❌ | 视频时长 `"4"`–`"12"` 秒，默认 `"5"` |
| `size` | string | ❌ | 输出档位，目前仅支持 `"720P"` |
| `aspect_ratio` | string | ❌ | 输出宽高比，默认 `16:9` |
| `seed` | integer | ❌ | 随机种子，复用可提高可复现性 |
| `n` | integer | ❌ | 输出数量，目前仅支持 `1`（默认） |

### 模式专属参数

| 参数 | 类型 | 适用模式 | 说明 |
|------|------|----------|------|
| `first_frame` | string | `keyframe` | 首帧图片 URL（与 `last_frame` 至少提供一个） |
| `last_frame` | string | `keyframe` | 尾帧图片 URL（与 `first_frame` 至少提供一个） |
| `images` | string[] | `reference` | 参考图片 URL |
| `audios` | string[] | `reference` | 参考音频 URL |
| `videos` | object[] | `reference` | 参考视频对象 |

> 所有媒体 URL 必须可被 Agnes AI 服务公开访问，避免需要认证、指向私有网络或在任务完成前过期。

### 生成模式规则

| `mode` | 用途 | 必需媒体 | 不允许的媒体字段 |
|--------|------|----------|-----------------|
| `text` | 仅从文本生成视频 | 无 | `first_frame`、`last_frame`、`images`、`audios`、`videos` |
| `keyframe` | 控制首帧、尾帧或两者 | 至少一个 `first_frame` 或 `last_frame` | `images`、`audios`、`videos` |
| `reference` | 从图片/音频/视频参考生成 | 至少一个非空 `images`、`audios` 或 `videos` 数组 | `first_frame`、`last_frame` |

> **提示**：`keyframe` 模式尽量保留输入图片作为实际首帧或尾帧，适合起止构图控制；`reference` 模式将媒体作为内容、风格、动作或节奏参考，可能重新构图或调整节奏。

### 参考视频对象字段

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 可公开访问的视频 URL |
| `start_seconds` | number | ❌ | 从该偏移量开始读取参考视频，默认 `0` |
| `require_audio` | boolean | ❌ | 要求参考视频包含音轨，默认 `false` |

> `<Picture N>`、`<Audio N>`、`<Video N>` 在各自数组中独立编号，从 `1` 开始。

### 请求示例

**文生视频：**

```bash
curl -sS -X POST "$AGNES_BASE_URL/videos" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-2.5",
    "prompt": "A futuristic city street after rain, neon lights reflected on the pavement, a silver sports car passing slowly, cinematic camera movement, natural ambient sound",
    "seconds": "5",
    "mode": "text",
    "size": "720P",
    "aspect_ratio": "16:9"
  }'
```

**首尾帧控制：**

```bash
curl -sS -X POST "$AGNES_BASE_URL/videos" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-2.5",
    "prompt": "The person turns naturally from the first-frame pose and walks toward the window. Keep clothing and hair motion realistic, slowly push the camera forward, and transition smoothly to the last-frame composition.",
    "seconds": "5",
    "mode": "keyframe",
    "size": "720P",
    "first_frame": "https://example.com/first.png",
    "last_frame": "https://example.com/last.png"
  }'
```

**图片参考：**

```bash
curl -sS -X POST "$AGNES_BASE_URL/videos" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-2.5",
    "prompt": "Use the character and art style in <Picture 1> as reference. The character runs naturally through a flower field, maintaining a consistent appearance, filmed from a low tracking angle.",
    "seconds": "5",
    "mode": "reference",
    "size": "720P",
    "aspect_ratio": "16:9",
    "images": ["https://example.com/character.png"]
  }'
```

**图片 + 音频参考：**

```bash
curl -sS -X POST "$AGNES_BASE_URL/videos" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-2.5",
    "prompt": "Use <Picture 1> as the visual subject and design the actions and camera cuts around the rhythm of <Audio 1>, keeping the sequence natural and coherent.",
    "seconds": "5",
    "mode": "reference",
    "size": "720P",
    "images": ["https://example.com/subject.png"],
    "audios": ["https://example.com/music.mp3"]
  }'
```

**视频参考：**

```bash
curl -sS -X POST "$AGNES_BASE_URL/videos" \
  -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-2.5",
    "prompt": "Follow the subject motion and camera rhythm of <Video 1>, changing the setting to a moonlit bedroom while preserving coherent timing.",
    "seconds": "5",
    "mode": "reference",
    "size": "720P",
    "aspect_ratio": "16:9",
    "videos": [
      {
        "url": "https://example.com/input.mp4",
        "start_seconds": 35,
        "require_audio": false
      }
    ]
  }'
```

### 创建任务响应

```json
{
  "id": "video_xxx",
  "object": "video",
  "model": "agnes-video-2.5",
  "status": "queued",
  "progress": 0,
  "created_at": 1786900000,
  "size": "720P",
  "seconds": "5",
  "quality": "standard",
  "url": null,
  "completed_at": null,
  "error": null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 视频任务 ID，用于结果检索 |
| `object` | string | 对象类型，恒为 `video` |
| `model` | string | 任务使用的模型 |
| `status` | string | `queued` / `in_progress` / `completed` / `failed` |
| `progress` | integer | 任务进度 0-100 |
| `created_at` | integer | 任务创建时间（Unix 时间戳） |
| `completed_at` | integer / null | 任务完成时间（完成前为 null） |
| `size` | string | 输出档位（当前 `720P`） |
| `seconds` | string | 视频时长（秒） |
| `quality` | string | 质量档位字段 |
| `url` | string / null | 任务完成后的视频 URL |
| `error` | object / null | 任务失败时的错误详情 |

### 查询任务结果

```bash
# 按 video_id 查询
curl -sS "https://apihub.agnes-ai.com/agnesapi?video_id=video_xxx" \
  -H "Authorization: Bearer $AGNES_API_KEY"

# 按 video_id + model_name 查询
curl -sS "https://apihub.agnes-ai.com/agnesapi?video_id=video_xxx&model_name=agnes-video-2.5" \
  -H "Authorization: Bearer $AGNES_API_KEY"
```

完成响应示例：

```json
{
  "id": "video_xxx",
  "object": "video",
  "model": "agnes-video-2.5",
  "status": "completed",
  "progress": 100,
  "created_at": 1786900000,
  "completed_at": 1786900120,
  "size": "720P",
  "seconds": "5",
  "quality": "standard",
  "url": "https://example.com/generated/video_xxx.mp4",
  "error": null
}
```

> **提示**：以 `status` 和 `url` 为准。仅当 `status` 为 `completed` 时 URL 才可用于交付。生产环境应设置最大轮询时长，并对网络超时和 `429` 响应使用退避策略。

### Python SDK 示例

```python
import os
import time
import requests
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AGNES_API_KEY"],
    base_url="https://apihub.agnes-ai.com/v1",
)

video = client.videos.create(
    model="agnes-video-2.5",
    prompt="Follow the motion and timing of <Video 1>, while changing the setting to a moonlit room.",
    seconds="5",
    size="720P",
    extra_body={
        "mode": "reference",
        "aspect_ratio": "16:9",
        "videos": [
            {
                "url": "https://example.com/input.mp4",
                "start_seconds": 0,
                "require_audio": False,
            }
        ],
    },
)

video_id = video.id

while True:
    time.sleep(1.5)
    response = requests.get(
        "https://apihub.agnes-ai.com/agnesapi",
        params={"video_id": video_id},
        headers={"Authorization": f"Bearer {os.environ['AGNES_API_KEY']}"},
        timeout=30,
    )
    response.raise_for_status()
    video = response.json()
    if video.get("status") in ("completed", "failed"):
        break

if video.get("status") == "failed":
    message = video.get("error", {}).get("message", "Video generation failed")
    raise RuntimeError(message)

print(video["url"])
```

### 尺寸与宽高比（720P）

| `aspect_ratio` | 输出像素 | 推荐用途 |
|----------------|----------|----------|
| `21:9` | 1680x720 | 超宽屏和电影感场景 |
| `16:9` | 1280x720 | 横屏视频和产品展示（默认） |
| `4:3` | 960x720 | 通用横屏和传统视频格式 |
| `1:1` | 720x720 | 方形社交信息流 |
| `3:4` | 720x960 | 竖屏演示和人像内容 |
| `9:16` | 720x1280 | 移动端短视频和竖屏视频 |

### 参数限制（返回 400）

以下参数和请求模式**不支持**：

- 通过 `video_url`、`video_path` 或 `video_reference` 传参考视频；应使用 `videos[].url`
- 通过 `input_reference` 或 `reference_url` 传媒体；应根据所选模式使用 `first_frame`、`last_frame`、`images`、`audios` 或 `videos`
- 发送 `width`、`height`、`fps`、`num_frames`、`quality`、`num_inference_steps` 等不可配置字段
- 在 `size` 中直接传 `1280x720` 等分辨率，或任何非 `"720P"` 的值；应通过 `aspect_ratio` 选择分辨率
- 设置 `aspect_ratio` 为 `auto` 或支持列表之外的值
- 设置 `n` 为非 `1` 的值
- 使用与 `mode` 冲突的媒体字段，或 `reference` 模式无任何参考媒体

### 错误处理

| HTTP 状态 | 常见原因 | 建议操作 |
|-----------|----------|----------|
| 400 | 缺少字段、无效 mode/媒体组合、时长或宽高比 | 检查请求字段和模式校验规则 |
| 401 / 403 | API Key 无效、过期或未授权 | 检查认证头、Key 状态和模型访问权限 |
| 404 | 视频任务 ID 不存在 | 使用创建响应返回的 `id` |
| 429 | 请求频率超限 | 使用指数退避并降低轮询频率 |
| 500 | 内部服务错误 | 稍后重试，持续则联系支持 |

### 计费（Video 2.5）

**720P 标价：** `$0.025 / 秒`

**标准计费公式：**

```text
总费用 = (输出视频秒数 + 输入视频秒数) × 输出分辨率单价
       + max(0, 参考图片数 - 5) × $0.005
```

| 计费项 | 标准规则 |
|--------|----------|
| 输出视频 | 实际输出视频时长 × 输出分辨率单价 |
| 输入视频 | 输入视频总时长 × 输出分辨率单价（多输入累加） |
| 参考图片 | 前 5 张免费，超出部分每张 $0.005 |

**当前促销计费：** 仅按输出视频时长计费，输入视频时长和参考图片暂时免费：

```text
当前费用 = 输出视频秒数 × 720P 标价
```

> **警告**：促销是临时的，结束日期和标准计费开始时间以 Agnes AI 平台公告为准。

**计费示例：** 生成 8 秒 720P 视频，使用 3 秒输入视频和 7 张参考图片：

```text
标准费用 = (8 + 3) × $0.025 + max(0, 7 - 5) × $0.005
         = $0.275 + $0.01
         = $0.285

当前促销费用 = 8 × $0.025 = $0.20
```

---

## 三、提示词最佳实践（通用）

### 文生视频提示词

```
[主体] + [动作] + [场景] + [运镜] + [光照] + [风格]
```

示例：`A young astronaut walking across a red desert planet, dust blowing in the wind, slow cinematic tracking shot, dramatic sunset lighting, realistic sci-fi style`

### 图生视频提示词

描述什么应该动、哪些关键主体元素应保持稳定。

### 关键帧动画提示词

清晰描述关键帧之间的转场关系，保持角色一致性、机位一致性和场景间自然运动。

### Video 2.5 提示词推荐结构

1. **主体与场景**：人物、物体、环境、时间
2. **动作与变化**：主体如何运动、场景如何演变
3. **镜头语言**：推、拉、摇、移、跟、固定机位、景别
4. **视觉风格**：光照、色彩、材质、写实度、氛围
5. **声音与节奏**：环境声或动作声描述，或引用音频输入
6. **一致性要求**：说明哪些角色、产品或构图细节必须保持不变

---

## 集成检查清单

- [ ] 使用正确模型 ID（`agnes-video-v2.0` / `agnes-video-2.5`）
- [ ] 使用 `https://apihub.agnes-ai.com/v1` 作为 Base URL
- [ ] 视频生成是异步的：先创建任务，再轮询获取结果
- [ ] 保存创建响应返回的 `id` / `video_id`
- [ ] 轮询 `GET /agnesapi?video_id=<VIDEO_ID>` 直到状态为 `completed` 或 `failed`；需显式指定模型时加 `model_name` 参数
- [ ] 图生视频、关键帧、参考模式使用可公开访问的媒体 URL
- [ ] Video 2.5：`seconds` 传 `"4"`–`"12"` 字符串、`n` 设为 `1`、`size` 设为 `"720P"` 并使用支持的 `aspect_ratio`
- [ ] 参数归一化后，以响应字段 `seconds` 和 `size` 为准
- [ ] 切勿在日志、客户端代码或公开仓库中暴露 API Key
