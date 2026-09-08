/** profile 注册表（纯函数，无 node 依赖，渲染层可直引）：
 *  解析链 = 特定实现（match 命中）→ 风格默认（兼容兜底）→ 明确报错（不发未知请求）。 */
import { FEATURE_LABEL, type AdapterPick, type ApiStyle, type MMFeature, type ProfileDesc, type ProfileMeta } from './types.js';

export { FEATURE_LABEL } from './types.js';

/** 风格判定：显式 apiStyle 优先，否则隐式路由（providerId=agnes 或模型名 agnes- 前缀） */
export function detectStyle(pick: AdapterPick): ApiStyle {
  return pick.apiStyle ?? (pick.providerId === 'agnes' || /^agnes-/.test(pick.model) ? 'agnes' : 'openai');
}

/** 风格中文名（错误信息用） */
export function styleName(style: ApiStyle): string {
  return style === 'agnes' ? 'Agnes' : 'OpenAI 兼容';
}

/** 全部 profile 描述符（实现按 id 绑定于 adapters/index.ts；同一实现可在多个能力下注册） */
export const PROFILE_DESCRIPTORS: ProfileDesc[] = [
  // 视频：Agnes v2.0（旧格式 width/height/num_frames）与 2.5 家族（mode/size 档位，含 2.5-flash）格式不同
  { id: 'agnes-video-v2.0', capability: 'video-generate', style: 'agnes', describe: 'Agnes · v2.0 旧格式', match: (m) => /v2\.0/i.test(m) },
  { id: 'agnes-video-v2.0', capability: 'video-from-frame', style: 'agnes', describe: 'Agnes · v2.0 旧格式', match: (m) => /v2\.0/i.test(m) },
  { id: 'agnes-video-2.5', capability: 'video-generate', style: 'agnes', describe: 'Agnes · 2.5 格式（含 2.5-flash）', match: (m) => /2\.5/.test(m), default: true },
  { id: 'agnes-video-2.5', capability: 'video-from-frame', style: 'agnes', describe: 'Agnes · 2.5 格式（含 2.5-flash）', match: (m) => /2\.5/.test(m), default: true },
  { id: 'siliconflow-async', capability: 'video-generate', style: 'openai', describe: 'SiliconFlow · 异步任务', default: true },
  { id: 'siliconflow-async', capability: 'video-from-frame', style: 'openai', describe: 'SiliconFlow · 异步任务', default: true },
  // 图像：Agnes（size 档位 + extra_body.image 图生图）/ OpenAI 兼容（image_size 精确像素）
  { id: 'agnes-image', capability: 'image-generate', style: 'agnes', describe: 'Agnes · images（size 档位）', default: true },
  { id: 'agnes-image', capability: 'image-edit', style: 'agnes', describe: 'Agnes · images（size 档位）', default: true },
  { id: 'openai-image', capability: 'image-generate', style: 'openai', describe: 'OpenAI 兼容 · images', default: true },
  // 向量 / 重排 / 语音：仅 OpenAI 兼容实现（Agnes 绑定时报错换绑）
  { id: 'openai-embed', capability: 'embed', style: 'openai', describe: 'OpenAI 兼容 · embeddings', default: true },
  { id: 'openai-rerank', capability: 'rerank', style: 'openai', describe: 'OpenAI 兼容 · rerank', default: true },
  { id: 'openai-tts', capability: 'tts', style: 'openai', describe: 'OpenAI 兼容 · audio/speech', default: true },
  { id: 'openai-asr', capability: 'asr', style: 'openai', describe: 'OpenAI 兼容 · transcriptions', default: true },
];

/** 解析某模型在指定能力上将使用的 profile；无可用实现 → 统一中文报错（含模型名与风格名） */
export function resolveProfileMeta(pick: AdapterPick, capability: MMFeature): ProfileMeta {
  const style = detectStyle(pick);
  const candidates = PROFILE_DESCRIPTORS.filter((d) => d.capability === capability);
  const specific = candidates.find((d) => d.style === style && d.match?.(pick.model));
  if (specific) return { profile: specific, kind: 'specific' };
  const fallback = candidates.find((d) => d.style === style && d.default);
  if (fallback) return { profile: fallback, kind: 'default' };
  throw new Error(`${FEATURE_LABEL[capability]}当前不支持该模型「${pick.model}」所属接口（${styleName(style)}），请到「设置 → 模型」换绑对应能力的模型`);
}
