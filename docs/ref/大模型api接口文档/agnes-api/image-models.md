# 图像模型（Image Models）

> 文档来源：
> - https://wiki.agnes-ai.com/en/docs/agnes-image-20-flash.md
> - https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash.md

## 模型总览

| 模型 ID | 说明 | 支持工作流 |
|---------|------|-----------|
| `agnes-image-2.0-flash` | 高性能图像生成与编辑模型 | 文生图、图生图、多图合成 |
| `agnes-image-2.1-flash` | 升级版，优化高信息密度图像 | 文生图、图生图、多图合成 |

### 价格

| 类型 | 标准价格 | 当前价格 |
|------|----------|----------|
| 图像生成 | $0.003 / 张 | $0 / 张 |

> 性能参考：Agnes Image 2.0 Flash 在 Artificial Analysis 图像编辑排行榜 ELO 分数 1184，位列 Top 20。

---

## 接口信息

- **方法**: POST
- **路径**: `/v1/images/generations`
- **认证**: `Authorization: Bearer YOUR_API_KEY`
- **Content-Type**: `application/json`

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 模型名称（`agnes-image-2.0-flash` / `agnes-image-2.1-flash`） |
| `prompt` | string | ✅ | 图像生成或编辑指令的文本提示 |
| `size` | string | ✅ | 输出图像尺寸。2.0：如 `1024x768`、`1024x1024`、`768x1024`；2.1：推荐 `1K`/`2K`/`3K`/`4K` 分级 |
| `ratio` | string | ❌ | 宽高比（仅 2.1，与分级 size 配合使用）：`1:1`、`3:4`、`4:3`、`16:9`、`9:16`、`2:3`、`3:2`、`21:9`，默认 `1:1` |
| `image` | string[] | 图生图时必填 | 输入图片数组，支持公开 URL 或 Data URI Base64 |
| `return_base64` | boolean | ❌ | 文生图输出以 Base64 返回时使用 |
| `extra_body.response_format` | string | ❌ | 输出格式：`url` 或 `b64_json` |

> **重要警告**：**不要将 `response_format` 放在请求体顶层**。URL 或 Base64 输出需放在 `extra_body` 内，否则可能返回 400 错误。

### 重要说明

| 场景 | 说明 |
|------|------|
| 文生图 | 仅需 `model`、`prompt`、`size`，不要传 `image` |
| 图生图 | 通过 `extra_body.image` 传图片 URL 或 Data URI Base64 |
| 多图合成 | 在 `extra_body.image` 传多个参考图片 |
| 无需 tags | 图生图请求不需要 `tags: ["img2img"]` |
| 客户端超时 | 图像生成可能耗时数秒到数十秒，建议客户端超时设置为 `60s - 360s` |

## 尺寸与比例（Agnes Image 2.1 Flash）

### 输出尺寸对照表

| 比例 | 1K | 2K | 3K | 4K |
|------|-----|-----|-----|-----|
| `1:1` | 1024x1024 | 2048x2048 | 3072x3072 | 4096x4096 |
| `3:4` | 864x1152 | 1728x2304 | 2592x3456 | 3456x4608 |
| `4:3` | 1152x864 | 2304x1728 | 3456x2592 | 4608x3456 |
| `16:9` | 1312x736 | 2624x1472 | 3936x2208 | 5248x2944 |
| `9:16` | 736x1312 | 1472x2624 | 2208x3936 | 2944x5248 |
| `2:3` | 832x1248 | 1664x2496 | 2496x3744 | 3328x4992 |
| `3:2` | 1248x832 | 2496x1664 | 3744x2496 | 4992x3328 |
| `21:9` | 1568x672 | 3136x1344 | 4704x2016 | 6272x2688 |

> **注意**：
> - 2.1 模型推荐使用 `size` 分级（`1K`~`4K`）+ `ratio` 的方式
> - 旧式精确尺寸（如 `1024x768`）也可接受，但不支持的尺寸可能被归一化
> - `1920x1080` 和 `2560x1440` 非原生输出尺寸，如需要 16:9 显示器素材，请请求 `size: "2K"` + `ratio: "16:9"` 后自行裁剪/缩放

## 请求示例

### 文生图（URL 输出）

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "A clean product photo of a glass cube on a white studio background, soft shadows, high detail",
    "size": "1024x768",
    "extra_body": {
      "response_format": "url"
    }
  }'
```

### 文生图（Base64 输出）

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "A clean product photo of a glass cube on a white studio background, soft shadows, high detail",
    "size": "1024x768",
    "return_base64": true
  }'
```

### 图生图（URL 输入 + URL 输出）

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "Transform this image into a cinematic cyberpunk style while preserving the main subject and composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "https://example.com/input-image.png"
      ],
      "response_format": "url"
    }
  }'
```

### 多图合成

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "Combine the two characters into an intense fantasy battle scene, dynamic lighting, detailed background, cinematic composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "https://example.com/character-1.png",
        "https://example.com/character-2.png"
      ],
      "response_format": "url"
    }
  }'
```

### 2.1 分级尺寸示例（16:9 2K）

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "A cinematic product hero image for a desktop monitor wallpaper, clean lighting, high detail",
    "size": "2K",
    "ratio": "16:9",
    "extra_body": {
      "response_format": "url"
    }
  }'
```

### Data URI Base64 输入

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "Make the object matte black while preserving the original composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "data:image/png;base64,BASE64_HERE"
      ],
      "response_format": "b64_json"
    }
  }'
```

## 响应格式

### URL 输出

```json
{
  "created": 1780000000,
  "data": [
    {
      "url": "https://storage.googleapis.com/agnes-aigc/xxx.png",
      "b64_json": null,
      "revised_prompt": null
    }
  ]
}
```

### Base64 输出

```json
{
  "created": 1780000000,
  "data": [
    {
      "url": null,
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": null
    }
  ]
}
```

### 响应字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `created` | integer | 请求创建时间戳 |
| `data` | array | 生成的图像结果列表 |
| `data[].url` | string / null | 生成图片 URL（Base64 输出时通常为 null） |
| `data[].b64_json` | string / null | Base64 图片数据（URL 输出时通常为 null） |
| `data[].revised_prompt` | string / null | 修订后的提示词（如有） |

---

## 提示词最佳实践

### 文生图提示词结构

```
[主体] + [场景/背景] + [风格] + [光照] + [构图] + [质量要求]
```

示例：`A professional product photo of a wireless headphone on a clean white background, soft studio lighting, sharp details, commercial photography style`

### 图生图提示词结构

```
[修改指令] + [保留元素] + [目标风格/场景] + [光照] + [构图] + [质量要求]
```

示例：`Change the background to a futuristic city at night while keeping the person's face, outfit, and pose unchanged`

### 多图合成提示词结构

描述输入图片之间的关系及如何组合：

示例：`Place the person from the first image beside the robot from the second image in a cinematic sci-fi battle scene`

### 高信息密度图像（2.1）

推荐描述以下要素：主体、背景环境、重要次要细节、风格与光照、构图约束、图生图需保留的元素。

---

## 常见错误与排查

| 问题 | 解决方案 |
|------|----------|
| 顶层 `response_format` 报错 | 将 `response_format` 放入 `extra_body` 内 |
| 图生图不需要 tags | 不要传 `tags: ["img2img"]`，直接传 `extra_body.image` |
| 输入图片 URL 无法访问 | 使用无需登录/ Cookie / 私有请求头的公开 HTTPS URL；无法公开则用 Data URI Base64 |
| 请求超时 | 客户端超时设置为 60s - 360s |
| 图生图缺少 image 参数 | 图生图和多图合成必须在 `extra_body.image` 传入输入图片数组 |

---

## 集成检查清单

- [ ] 使用正确模型名（`agnes-image-2.0-flash` / `agnes-image-2.1-flash`）
- [ ] 使用 `https://apihub.agnes-ai.com/v1/images/generations` 端点
- [ ] 文生图包含 `model`、`prompt`、`size`
- [ ] 可预测尺寸时使用 `size` 分级（`1K`/`2K`）+ `ratio`（仅 2.1）
- [ ] 图生图 / 多图合成通过 `extra_body.image` 传入图片
- [ ] 不要将 `response_format` 放在请求体顶层
- [ ] 不要在公开文档中暴露真实 API Key
