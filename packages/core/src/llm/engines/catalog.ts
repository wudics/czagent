/**
 * 接口实现目录（纯元数据，无 node 依赖，渲染层设置页可直引）：
 * 每个条目 = 一"家"接口实现（provider/版本粒度），声明显示名、适用能力与默认地址。
 * 实现绑定在 llm/engines/index.ts（id 一一对应）；新增 provider = 新引擎文件 + 此处与注册表各加一行。
 */
import type { Capability } from '../../provider.js';

export type ImplCategory = 'chat' | Capability;

export interface ImplMeta {
  id: string;
  /** 设置页下拉显示名 */
  name: string;
  category: ImplCategory;
  /** 添加模型时的默认 API 地址（预填用；空 = 需用户自填） */
  defaultBaseUrl: string;
  /** 补充说明（下拉选项 title） */
  description?: string;
}

/** 对话接口实现（chat 模型与 image-understanding 模型的候选） */
export const CHAT_IMPL_META: ImplMeta[] = [
  { id: 'deepseek', name: 'DeepSeek', category: 'chat', defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'siliconflow', name: 'SiliconFlow', category: 'chat', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'agnes', name: 'Agnes', category: 'chat', defaultBaseUrl: 'https://apihub.agnes-ai.com/v1' },
  { id: 'bigmodel', name: 'BigModel', category: 'chat', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'qwen', name: 'Qwen', category: 'chat', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'openrouter', name: 'OpenRouter', category: 'chat', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'openai-compatible', name: 'OpenAI 兼容（自定义）', category: 'chat', defaultBaseUrl: '', description: '通用 OpenAI 兼容接口：自填地址与 Key，无平台差异参数' },
];

/** 多模态/专用接口实现（按 capability 过滤为对应能力模型的候选） */
export const MM_IMPL_META: ImplMeta[] = [
  { id: 'agnes-video-v2.0', name: 'Agnes 视频 · v2.0 旧格式', category: 'video-generation', defaultBaseUrl: 'https://apihub.agnes-ai.com/v1' },
  { id: 'agnes-video-2.5', name: 'Agnes 视频 · 2.5（含 flash）', category: 'video-generation', defaultBaseUrl: 'https://apihub.agnes-ai.com/v1' },
  { id: 'siliconflow-video', name: 'SiliconFlow 视频 · 异步任务', category: 'video-generation', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'agnes-image', name: 'Agnes 图像（size 档位）', category: 'image-generation', defaultBaseUrl: 'https://apihub.agnes-ai.com/v1', description: '支持图生图（edit）' },
  { id: 'openai-image', name: 'OpenAI 兼容图像（精确像素）', category: 'image-generation', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openai-embed', name: 'OpenAI 兼容 embeddings', category: 'embedding', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openai-rerank', name: 'OpenAI 兼容 rerank', category: 'rerank', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openai-tts', name: 'OpenAI 兼容 audio/speech', category: 'tts', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openai-asr', name: 'OpenAI 兼容 transcriptions', category: 'asr', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
];

export function implMetaOf(id: string): ImplMeta | undefined {
  return CHAT_IMPL_META.find((m) => m.id === id) ?? MM_IMPL_META.find((m) => m.id === id);
}
