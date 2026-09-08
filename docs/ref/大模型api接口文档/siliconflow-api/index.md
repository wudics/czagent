# SiliconFlow API 接口文档

> 文档来源：https://api-docs.siliconflow.cn/docs/userguide/introduction
> 整理日期：2026-08-21

## 概述

SiliconFlow（硅基流动）平台基于自研推理引擎、弹性计算基础设施和可扩展的 API 服务，提供大模型 API 与部署服务。平台覆盖语言、语音、图像、视频、Embedding 等场景与模态，兼容 OpenAI 和 Anthropic 协议。

## 基础信息

| 参数 | 值 |
|------|-----|
| Base URL | `https://api.siliconflow.cn/v1` |
| 认证方式 | `Authorization: Bearer {API_KEY}` |
| 平台控制台 | https://cloud.siliconflow.cn/ |
| API Key 管理 | https://cloud.siliconflow.cn/account/ak |
| 模型列表 | https://cloud.siliconflow.cn/models |

> 响应头包含 `x-siliconcloud-trace-id` 字段，作为请求唯一标识，便于日志查询与问题排查。

## 平台核心能力

| 能力 | 说明 |
|------|------|
| 即开即用大模型 API | 覆盖语言、语音、图像、视频、Embedding 场景，兼容 OpenAI/Anthropic 协议 |
| 专属实例（Dedicated Instances） | 企业核心推理场景，专属算力 |
| 推理加速 | 自研推理引擎，低延迟、高吞吐 |
| 私有化部署 | 企业级私有化部署（网关 + 推理） |

## 平台优势

1. **高速推理**：自研推理引擎降低推理延迟最高 70%，吞吐量提升 3–5 倍
2. **高性价比**：动态量化降低推理计算需求 60%–80%
3. **高稳定性**：企业级 SLA，全面监控与容错
4. **高智能**：涵盖 LLM 与多模态模型
5. **高安全**：支持 BYOC（Bring Your Own Cloud）部署
6. **高可扩展**：动态扩缩容，一键自定义模型部署

## API 端点索引

### Chat 模块

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/chat/completions` | POST | 创建对话补全（OpenAI 兼容） | [chat-completions.md](./chat-completions.md) |
| `/messages` | POST | 创建消息（Anthropic 兼容） | [messages.md](./messages.md) |
| `/embeddings` | POST | 创建 Embedding 向量 | [embeddings.md](./embeddings.md) |
| `/rerank` | POST | 文档相关性重排 | [rerank.md](./rerank.md) |

### Image 模块

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/images/generations` | POST | 图像生成 | [images.md](./images.md) |

### Audio 模块

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/uploads/audio/voice` | POST | 上传自定义语音 | [audio.md](./audio.md) |
| `/audio/speech` | POST | 语音合成（TTS） | [audio.md](./audio.md) |
| `/audio/voice/list` | GET | 列出自定义语音 | [audio.md](./audio.md) |
| `/audio/voice/deletions` | POST | 删除自定义语音 | [audio.md](./audio.md) |
| `/audio/transcriptions` | POST | 音频转录（ASR） | [audio.md](./audio.md) |

### Video 模块

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/video/submit` | POST | 提交视频生成任务 | [video.md](./video.md) |
| `/video/status` | POST | 查询视频生成状态 | [video.md](./video.md) |

### Batch 模块

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/files` | GET | 列出文件 | [batch.md](./batch.md) |
| `/files` | POST | 上传文件 | [batch.md](./batch.md) |
| `/batches` | GET | 列出批次任务 | [batch.md](./batch.md) |
| `/batches` | POST | 创建批次任务 | [batch.md](./batch.md) |
| `/batches/{batch_id}` | GET | 查询批次状态 | [batch.md](./batch.md) |
| `/batches/{batch_id}/cancel` | POST | 取消批次任务 | [batch.md](./batch.md) |

### Platform 模块

| 端点 | 方法 | 说明 | 文档 |
|------|------|------|------|
| `/models` | GET | 列出可用模型 | [models.md](./models.md) |

## 常见错误码

| 状态码 | 常见原因 | 解决方案 |
|--------|----------|----------|
| 400 | 参数格式错误 | 检查参数取值范围（如 temperature） |
| 401 | API Key 未正确设置 | 检查 API Key |
| 403 | 权限不足 | 常见原因：模型需要实名认证 |
| 404 | 页面或资源不存在 | 检查请求路径 |
| 429 | 超过请求频率限制 | 实现指数退避重试机制 |
| 503/504 | 模型过载 | 切换到备用模型节点 |

## 计费说明

计费公式：`总费用 = (输入 tokens × 输入单价) + (输出 tokens × 输出单价)`

各模型具体价格可在模型详情页查看。
