/**
 * LLM 网关：业务代码（session-manager / 工具层）唯一的模型调用入口。
 * 解析（模型 → implId → 引擎）+ 校验（存在/Key/注册）+ 路由全部收敛于此；
 * 未实现/未注册 → 主动中文报错，绝不向未知地址发请求。
 */
import type { MultimodalCapability, Settings } from '../provider.js';
import type { ChatBinding, ChatEngine, ChatReq, LLMEvent } from './types.js';
import type { AsrReq, GenImage, ImageEditReq, ImageGenerateReq, MMEngine, MMBinding, MMCtx, RerankHit, RerankReq, TtsReq, VideoFrameReq, VideoTaskResult, VideoTextReq } from './engines/types.js';
import { CHAT_ENGINES, MM_ENGINES } from './engines/index.js';

/** 多模态能力中文名（报错/展示用） */
export const CAPABILITY_LABEL: Record<MultimodalCapability, string> = {
  embedding: '向量化（embedding）',
  rerank: '重排序（rerank）',
  'image-understanding': '图片理解',
  tts: '语音合成（TTS）',
  asr: '语音识别（ASR）',
  'image-generation': '图像生成',
  'video-generation': '视频生成',
};

/** 解析后的对话调用目标（chat 模型与图片理解模型的统一视图，字段差异已在解析时抹平） */
export interface ResolvedChat {
  /** 模型内部 id（usage 记账/日志用） */
  modelId: string;
  displayName: string;
  binding: ChatBinding;
  engine: ChatEngine;
  /** 是否支持视觉输入（图片内联） */
  vision: boolean;
  /** 是否注入 tools */
  toolcall: boolean;
  /** 最大输出 token（0 = 不限） */
  maxOutput: number;
  /** 上下文窗口（0 = 未知/不限制） */
  contextLimit: number;
  /** 透传给引擎的额外请求体参数 */
  options?: Record<string, unknown>;
}

/** 多模态引擎执行上下文（工具层/调用方传入；缺省 = 无中断、无进度上报） */
export interface GatewayCtx {
  signal?: AbortSignal;
  report?: (msg: string) => void;
}

function mmCtxOf(ctx?: GatewayCtx): MMCtx {
  return {
    signal: ctx?.signal ?? new AbortController().signal,
    report: ctx?.report ?? (() => {}),
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export class Gateway {
  /**
   * 解析对话模型（chat 模型，或图片理解模型）为可调用目标。
   * 抛错场景：模型不存在 / 未配置 Key / implId 未注册。
   */
  resolveChat(settings: Settings, modelId: string): ResolvedChat {
    const model =
      settings.chatModels.find((m) => m.id === modelId) ??
      settings.multimodalModels.find((m) => m.id === modelId && m.capability === 'image-understanding');
    if (!model) {
      throw new Error('未找到该会话对应的模型配置，请到「设置 → 模型」检查后再试。');
    }
    if (!model.apiKey) {
      throw new Error(`模型「${model.displayName}」尚未配置 API Key，请到「设置 → 模型」填写后再试。`);
    }
    const engine = CHAT_ENGINES[model.implId];
    if (!engine) {
      throw new Error(`模型「${model.displayName}」的接口实现（${model.implId}）不可用，请到「设置 → 模型」重新选择接口。`);
    }
    return {
      modelId: model.id,
      displayName: model.displayName,
      binding: { baseUrl: trimSlash(model.baseUrl), apiKey: model.apiKey, modelName: model.modelName },
      engine,
      vision: !('vision' in model) || model.vision !== false,
      toolcall: !('toolcall' in model) || model.toolcall !== false,
      maxOutput: ('maxOutput' in model ? model.maxOutput : 0) ?? 0,
      contextLimit: ('contextLimit' in model ? model.contextLimit : 0) ?? 0,
      options: model.options,
    };
  }

  /** resolveChat 的静默版：失败返回 null（调用方自行兜底，如运行中切换模型场景） */
  resolveChatOrNull(settings: Settings, modelId: string): ResolvedChat | null {
    try {
      return this.resolveChat(settings, modelId);
    } catch {
      return null;
    }
  }

  /** 统一对话流：chat 模型与图片理解模型共用；模型配置的 options 与调用方 options 合并（调用方优先） */
  async *chat(settings: Settings, modelId: string, req: ChatReq): AsyncGenerator<LLMEvent> {
    const target = this.resolveChat(settings, modelId);
    const merged: ChatReq = { ...req, options: { ...(target.options ?? {}), ...(req.options ?? {}) } };
    yield* target.engine.stream(target.binding, merged);
  }

  // ---- 多模态：按能力绑定解析 → 引擎分发 ----

  private resolveMM(settings: Settings, capability: MultimodalCapability): { model: Settings['multimodalModels'][number]; binding: MMBinding; engine: MMEngine } {
    const label = CAPABILITY_LABEL[capability];
    const modelId = settings.bindings.find((b) => b.capability === capability)?.modelId;
    const model = settings.multimodalModels.find((m) => m.id === modelId && m.enabled);
    if (!model) {
      throw new Error(`未配置${label}模型，请到「设置 → 模型」中绑定后再试`);
    }
    if (!model.apiKey) {
      throw new Error(`${label}模型「${model.displayName}」尚未配置 API Key，请到「设置 → 模型」填写后再试`);
    }
    const engine = MM_ENGINES[model.implId];
    if (!engine) {
      throw new Error(`${label}模型「${model.displayName}」的接口实现（${model.implId}）不可用，请到「设置 → 模型」重新选择接口`);
    }
    return { model, binding: { baseUrl: trimSlash(model.baseUrl), apiKey: model.apiKey, model: model.modelName }, engine };
  }

  async embed(settings: Settings, texts: string[], ctx?: GatewayCtx): Promise<number[][]> {
    const { engine, binding } = this.resolveMM(settings, 'embedding');
    if (!engine.embed) throw new Error('当前接口实现不支持向量化（embedding），请到「设置 → 模型」换绑对应模型');
    return engine.embed(binding, mmCtxOf(ctx), texts);
  }

  async rerank(settings: Settings, req: RerankReq, ctx?: GatewayCtx): Promise<RerankHit[]> {
    const { engine, binding } = this.resolveMM(settings, 'rerank');
    if (!engine.rerank) throw new Error('当前接口实现不支持重排序（rerank），请到「设置 → 模型」换绑对应模型');
    return engine.rerank(binding, mmCtxOf(ctx), req);
  }

  async generateImage(settings: Settings, req: ImageGenerateReq, ctx?: GatewayCtx): Promise<GenImage[]> {
    const { engine, binding } = this.resolveMM(settings, 'image-generation');
    if (!engine.generate) throw new Error('当前接口实现不支持图像生成，请到「设置 → 模型」换绑对应模型');
    return engine.generate(binding, mmCtxOf(ctx), req);
  }

  async editImage(settings: Settings, req: ImageEditReq, ctx?: GatewayCtx): Promise<GenImage[]> {
    const { engine, binding } = this.resolveMM(settings, 'image-generation');
    if (!engine.edit) {
      throw new Error('当前接口实现不支持图生图（edit），请到「设置 → 模型」为图像生成换绑 Agnes 图像模型');
    }
    return engine.edit(binding, mmCtxOf(ctx), req);
  }

  async generateVideo(settings: Settings, req: VideoTextReq, ctx?: GatewayCtx): Promise<VideoTaskResult> {
    const { engine, binding } = this.resolveMM(settings, 'video-generation');
    if (!engine.videoFromText) throw new Error('当前接口实现不支持视频生成，请到「设置 → 模型」换绑对应模型');
    return engine.videoFromText(binding, mmCtxOf(ctx), req);
  }

  async videoFromFrame(settings: Settings, req: VideoFrameReq, ctx?: GatewayCtx): Promise<VideoTaskResult> {
    const { engine, binding } = this.resolveMM(settings, 'video-generation');
    if (!engine.videoFromFrame) throw new Error('当前接口实现不支持图生视频，请到「设置 → 模型」换绑对应模型');
    return engine.videoFromFrame(binding, mmCtxOf(ctx), req);
  }

  async tts(settings: Settings, req: TtsReq, ctx?: GatewayCtx): Promise<Buffer> {
    const { engine, binding } = this.resolveMM(settings, 'tts');
    if (!engine.tts) throw new Error('当前接口实现不支持语音合成（TTS），请到「设置 → 模型」换绑对应模型');
    return engine.tts(binding, mmCtxOf(ctx), req);
  }

  async asr(settings: Settings, req: AsrReq, ctx?: GatewayCtx): Promise<string> {
    const { engine, binding } = this.resolveMM(settings, 'asr');
    if (!engine.asr) throw new Error('当前接口实现不支持语音识别（ASR），请到「设置 → 模型」换绑对应模型');
    return engine.asr(binding, mmCtxOf(ctx), req);
  }
}
