/** 多模态引擎类型（单模型粒度各自选择实现；MMEngine 方法按需实现，网关调用前校验）。 */

export interface MMBinding {
  baseUrl: string;
  apiKey: string;
  /** 请求体 model 参数 */
  model: string;
}

/** 执行上下文：中断信号 + 进度上报（写入当前工具卡片） */
export interface MMCtx {
  signal: AbortSignal;
  report(msg: string): void;
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
  /** 原始输入：http(s)/data URI 或本地路径；URL 规则各家不同，由实现处理 */
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
  /** 接口实现展示名（排障/输出用） */
  implementation: string;
  /** 任务查询端点（排障用，如 Agnes GET /agnesapi?video_id=…） */
  queryUrl?: string;
}

export interface ImageGenerateReq {
  prompt: string;
  size?: string;
  ratio?: string;
}

export interface ImageEditReq {
  prompt: string;
  images: string[];
  size?: string;
  ratio?: string;
}

export interface RerankReq {
  query: string;
  documents: string[];
  topN: number;
}

export interface TtsReq {
  text: string;
  voice?: string;
}

export interface AsrReq {
  buffer: Buffer;
  filename: string;
}

/** 多模态引擎：各实现按其支持的能力实现对应方法（未实现 = 不支持，网关显式报错） */
export interface MMEngine {
  videoFromText?(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult>;
  videoFromFrame?(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult>;
  generate?(b: MMBinding, ctx: MMCtx, req: ImageGenerateReq): Promise<GenImage[]>;
  /** 图生图（可选：如仅 Agnes 图像实现提供） */
  edit?(b: MMBinding, ctx: MMCtx, req: ImageEditReq): Promise<GenImage[]>;
  embed?(b: MMBinding, ctx: MMCtx, texts: string[]): Promise<number[][]>;
  rerank?(b: MMBinding, ctx: MMCtx, req: RerankReq): Promise<RerankHit[]>;
  tts?(b: MMBinding, ctx: MMCtx, req: TtsReq): Promise<Buffer>;
  asr?(b: MMBinding, ctx: MMCtx, req: AsrReq): Promise<string>;
}
