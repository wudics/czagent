/** 多模态适配层（I15 引入 / I17 profile 化）：按能力拆分 profile，统一解析链（特定实现 → 风格默认兜底 → 明确报错）。
 *  本文件仅类型 + 纯常量，无 node 依赖（渲染层设置页可直引）。 */

export interface MMBinding {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 执行上下文：中断信号 + 进度上报（写入当前工具卡片） */
export interface MMCtx {
  signal: AbortSignal;
  report(msg: string): void;
}

/** 特性键（= 工具 id / 解析粒度） */
export type MMFeature = 'embed' | 'rerank' | 'image-generate' | 'image-edit' | 'video-generate' | 'video-from-frame' | 'tts' | 'asr';

/** 特性中文名（报错/展示用） */
export const FEATURE_LABEL: Record<MMFeature, string> = {
  embed: '向量化（embedding）',
  rerank: '重排序（rerank）',
  'image-generate': '图像生成',
  'image-edit': '图生图',
  'video-generate': '视频生成',
  'video-from-frame': '视频生成',
  tts: '语音合成（TTS）',
  asr: '语音识别（ASR）',
};

/** 接口风格：openai = OpenAI 兼容（SiliconFlow 系格式），agnes = Agnes 格式 */
export type ApiStyle = 'openai' | 'agnes';

/** profile 解析输入（providerId/model/apiStyle） */
export interface AdapterPick {
  providerId: string;
  model: string;
  apiStyle?: ApiStyle;
}

/** profile 描述符：元数据（与实现分离，registry 持有；实现按 id 绑定在 adapters/index） */
export interface ProfileDesc {
  id: string;
  capability: MMFeature;
  style: ApiStyle;
  /** 展示名（设置页徽标 / 工具输出） */
  describe: string;
  /** 特定实现：模型名匹配（命中优先选用）；不设 = 仅作风格默认兜底 */
  match?: (model: string) => boolean;
  /** 风格默认实现（兼容兜底） */
  default?: boolean;
}

export interface ProfileMeta {
  profile: ProfileDesc;
  /** specific = 模型特定实现；default = 风格默认（兼容兜底） */
  kind: 'specific' | 'default';
}

/** 归一化的生成图片输出 */
export interface GenImage {
  b64?: string;
  url?: string;
}

export interface RerankHit {
  index: number;
  score?: number;
}

export interface VideoTextReq {
  prompt: string;
  seconds?: string;
  aspectRatio?: string;
  pollIntervalMs?: number;
}

export interface VideoFrameReq {
  prompt: string;
  /** 原始输入：http(s)/data URI 或本地路径；URL 规则各家不同，由 profile 处理 */
  firstFrame: string;
  lastFrame?: string;
  seconds?: string;
  aspectRatio?: string;
  pollIntervalMs?: number;
}

/** 视频生成结果：除最终 URL 外透出任务关键信息（视频 ID / 任务 ID / 模型 / 接口实现） */
export interface VideoTaskResult {
  url: string;
  videoId?: string;
  taskId?: string;
  model: string;
  /** 接口实现展示名（profile describe） */
  implementation: string;
  /** 任务查询端点（排障用，如 Agnes GET /agnesapi?video_id=…） */
  queryUrl?: string;
}

// ---------- 各能力 profile 实现接口 ----------

export interface VideoProfileImpl {
  videoFromText(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult>;
  videoFromFrame(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult>;
}

export interface ImageProfileImpl {
  generate(b: MMBinding, ctx: MMCtx, req: { prompt: string; size?: string; ratio?: string }): Promise<GenImage[]>;
  /** 图生图（可选：仅 Agnes 图像 profile 提供） */
  edit?(b: MMBinding, ctx: MMCtx, req: { prompt: string; images: string[]; size?: string; ratio?: string }): Promise<GenImage[]>;
}

export interface EmbedProfileImpl {
  embed(b: MMBinding, ctx: MMCtx, texts: string[]): Promise<number[][]>;
}

export interface RerankProfileImpl {
  rerank(b: MMBinding, ctx: MMCtx, req: { query: string; documents: string[]; topN: number }): Promise<RerankHit[]>;
}

export interface TtsProfileImpl {
  tts(b: MMBinding, ctx: MMCtx, req: { text: string; voice?: string }): Promise<Buffer>;
}

export interface AsrProfileImpl {
  asr(b: MMBinding, ctx: MMCtx, req: { buffer: Buffer; filename: string }): Promise<string>;
}
