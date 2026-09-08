# Agnes AI API 接口文档

> 文档来源：https://agnes-ai.com/zh-Hans/docs/overview 与 https://wiki.agnes-ai.com/
> 整理日期：2026-08-21

## 概述

Agnes AI API 为开发者提供统一、稳定、易于集成的多模态 AI 模型服务，支持文本、图像、视频和多模态生成与理解能力。API 兼容 OpenAI 风格接口，开发者可轻松迁移和集成现有项目。

## 基础信息

| 参数 | 值 |
|------|-----|
| Base URL | `https://apihub.agnes-ai.com/v1` |
| 认证方式 | `Authorization: Bearer YOUR_API_KEY` |
| 平台控制台 | Agnes AI Platform（开发者仪表盘） |
| 技术支持 | support@agnes-ai.com |

> 已使用 OpenAI 兼容 API 的开发者，通常只需修改 `Base URL`、`API Key`、`模型名称` 三项配置即可迁移。

## 模型列表

### 文本模型

| 模型 ID | 类型 | 上下文窗口 | 最大输出 | 价格（输入/输出，1M tokens） |
|---------|------|-----------|----------|------------------------------|
| `agnes-2.0-flash` | 快速高效文本模型 | 512K | 65.5K | 标价 $0.03 / $0.15，当前 $0 |
| `agnes-2.5-flash` | 2.0 升级版（GA） | 512K | 65.5K | 标价 $0.03 / $0.15，当前 $0 |
| `agnes-2.5-pro-alpha` | 付费推理模型 | 1M | 65536 | 缓存命中 $0.0038 / 输入 $0.45 / 输出 $0.90 |
| `agnes-2.5-pro` | 2.5 Pro Alpha 商业稳定版 | 1M | 65536 | 缓存命中 $0.0038 / 输入 $0.45 / 输出 $0.90 |

### 图像模型

| 模型 ID | 类型 | 端点 | 价格 |
|---------|------|------|------|
| `agnes-image-2.0-flash` | 文生图 / 图生图 / 多图合成 | `POST /v1/images/generations` | 标价 $0.003/张，当前 $0 |
| `agnes-image-2.1-flash` | 高信息密度升级版 | `POST /v1/images/generations` | 标价 $0.003/张，当前 $0 |

### 视频模型

| 模型 ID | 类型 | 创建任务 | 查询结果 | 价格 |
|---------|------|----------|----------|------|
| `agnes-video-v2.0` | 文生视频 / 图生视频 / 关键帧动画 | `POST /v1/videos` | `GET /agnesapi?video_id=<ID>` | 标价 $0.005/秒，当前 $0 |
| `agnes-video-2.5` | 文生视频 / 关键帧 / 多模态参考 | `POST /v1/videos` | `GET /agnesapi?video_id=<ID>` | 720P 标价 $0.025/秒（促销仅按输出时长计费） |

## API 端点索引

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/v1/chat/completions` | POST | 对话补全（OpenAI 兼容） | [text-models.md](./text-models.md) |
| `/v1/responses` | POST | Responses API（OpenAI 格式） | [text-models.md](./text-models.md) |
| `/v1/messages` | POST | Messages API（Anthropic 兼容） | [text-models.md](./text-models.md) |
| `/v1/images/generations` | POST | 图像生成与编辑 | [image-models.md](./image-models.md) |
| `/v1/videos` | POST | 创建视频生成任务 | [video-models.md](./video-models.md) |
| `/agnesapi?video_id=<ID>` | GET | 查询视频生成结果 | [video-models.md](./video-models.md) |
| `/v1/videos/<TASK_ID>` | GET | 查询视频结果（旧版兼容） | [video-models.md](./video-models.md) |

## 安全提示

API Key 是敏感信息，请妥善保管。请勿在以下场景暴露：

- 公开代码仓库
- 前端客户端代码
- 截图或屏幕录制
- 公开文档 / 他人可访问的配置文件

> 如 API Key 不慎泄露，请立即在控制台删除或重置。

## 错误码速查

| 状态码 | 含义 | 常见原因 |
|--------|------|----------|
| 400 | 请求参数无效 | 请求体格式错误、缺少必填参数、上下文超限 |
| 401 | 认证失败 | API Key 错误、过期或未正确配置 |
| 402 | 余额不足 | 账户余额或 Token Plan 配额不足 |
| 403 | 无权限 | API Key 无权访问请求的模型 |
| 404 | 资源不存在 | Base URL / 路径 / 模型名错误 |
| 405 | 方法不允许 | HTTP 方法使用错误 |
| 408 | 请求超时 | 网络不稳定或任务处理时间过长 |
| 409 | 资源冲突 | 重复提交任务 |
| 413 | 请求体过大 | 上下文过长、base64 图片过大 |
| 415 | 媒体类型不支持 | 文件格式或 Content-Type 错误 |
| 422 | 参数值无效 | 参数超出允许范围、图片 URL 不可访问 |
| 429 | 请求频率超限 | 超过 RPM 限制（免费用户 RPM 20） |
| 500 | 服务器内部错误 | 参数异常触发服务异常 |
| 502/503/504/520/522/524 | 网关/服务异常 | 上游服务波动、超时、过载 |

详细错误码说明见 [error-codes.md](./error-codes.md)。

## 文档索引

| 文档 | 说明 |
|------|------|
| [quickstart.md](./quickstart.md) | 快速开始指南 |
| [text-models.md](./text-models.md) | 文本模型（2.0/2.5 Flash、2.5 Pro、2.5 Pro Alpha） |
| [image-models.md](./image-models.md) | 图像模型（Image 2.0/2.1 Flash） |
| [video-models.md](./video-models.md) | 视频模型（Video V2.0 / 2.5） |
| [error-codes.md](./error-codes.md) | 通用错误码与解决方案 |
| [faqs.md](./faqs.md) | 常见问题 FAQ |
