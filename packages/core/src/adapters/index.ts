/** 适配层入口（node 侧）：registry 元数据解析（纯）× profiles 实现（node）绑定。
 *  工具层唯一入口 resolveCapability：按能力解析 profile 并取出执行器；无实现 → 统一中文报错。 */
import type {
  AdapterPick,
  AsrProfileImpl,
  EmbedProfileImpl,
  ImageProfileImpl,
  MMFeature,
  ProfileMeta,
  RerankProfileImpl,
  TtsProfileImpl,
  VideoProfileImpl,
} from './types.js';
import { resolveProfileMeta } from './registry.js';
import { agnesV20Video, agnes25Video, siliconflowVideo } from './profiles/video.js';
import { agnesImage, openaiImage } from './profiles/image.js';
import { openaiEmbed, openaiRerank } from './profiles/embedding.js';
import { openaiTts, openaiAsr } from './profiles/audio.js';

// profile id → 实现（与 registry.ts PROFILE_DESCRIPTORS 的 id 对应；缺失即注册表未同步）
const VIDEO_IMPLS: Record<string, VideoProfileImpl> = {
  'agnes-video-v2.0': agnesV20Video,
  'agnes-video-2.5': agnes25Video,
  'siliconflow-async': siliconflowVideo,
};
const IMAGE_IMPLS: Record<string, ImageProfileImpl> = { 'agnes-image': agnesImage, 'openai-image': openaiImage };
const EMBED_IMPLS: Record<string, EmbedProfileImpl> = { 'openai-embed': openaiEmbed };
const RERANK_IMPLS: Record<string, RerankProfileImpl> = { 'openai-rerank': openaiRerank };
const TTS_IMPLS: Record<string, TtsProfileImpl> = { 'openai-tts': openaiTts };
const ASR_IMPLS: Record<string, AsrProfileImpl> = { 'openai-asr': openaiAsr };

function missingImpl(id: string): never {
  throw new Error(`profile 实现缺失：${id}（注册表与实现未同步）`);
}

export function resolveCapability(pick: AdapterPick, feature: 'video-generate' | 'video-from-frame'): ProfileMeta & { video: VideoProfileImpl };
export function resolveCapability(pick: AdapterPick, feature: 'image-generate' | 'image-edit'): ProfileMeta & { image: ImageProfileImpl };
export function resolveCapability(pick: AdapterPick, feature: 'embed'): ProfileMeta & { embed: EmbedProfileImpl };
export function resolveCapability(pick: AdapterPick, feature: 'rerank'): ProfileMeta & { rerank: RerankProfileImpl };
export function resolveCapability(pick: AdapterPick, feature: 'tts'): ProfileMeta & { tts: TtsProfileImpl };
export function resolveCapability(pick: AdapterPick, feature: 'asr'): ProfileMeta & { asr: AsrProfileImpl };
export function resolveCapability(pick: AdapterPick, feature: MMFeature) {
  const meta = resolveProfileMeta(pick, feature);
  const id = meta.profile.id;
  switch (feature) {
    case 'video-generate':
    case 'video-from-frame':
      return { ...meta, video: VIDEO_IMPLS[id] ?? missingImpl(id) };
    case 'image-generate':
    case 'image-edit':
      return { ...meta, image: IMAGE_IMPLS[id] ?? missingImpl(id) };
    case 'embed':
      return { ...meta, embed: EMBED_IMPLS[id] ?? missingImpl(id) };
    case 'rerank':
      return { ...meta, rerank: RERANK_IMPLS[id] ?? missingImpl(id) };
    case 'tts':
      return { ...meta, tts: TTS_IMPLS[id] ?? missingImpl(id) };
    case 'asr':
      return { ...meta, asr: ASR_IMPLS[id] ?? missingImpl(id) };
  }
}

export { resolveProfileMeta, detectStyle, styleName, PROFILE_DESCRIPTORS } from './registry.js';
export { FEATURE_LABEL, type ApiStyle, type AdapterPick, type MMFeature, type ProfileDesc, type ProfileMeta } from './types.js';
export type { MMBinding, MMCtx, GenImage, RerankHit, VideoTextReq, VideoFrameReq, VideoTaskResult } from './types.js';
export type { VideoProfileImpl, ImageProfileImpl, EmbedProfileImpl, RerankProfileImpl, TtsProfileImpl, AsrProfileImpl } from './types.js';
export { HttpError, IMAGE_TIMEOUT_MS, VIDEO_POLL_INTERVAL_MS, MAX_GENERATED_BYTES, postJson, downloadAsDataUrl, toDataUrl, extractImageOutputs, readProgress } from './shared.js';
