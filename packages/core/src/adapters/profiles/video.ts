/** 视频 profile 实现：agnes-v2.0（旧格式）、agnes-2.5（mode 自动探测，覆盖 2.5-flash）、siliconflow-async。 */
import { readFileSync } from 'node:fs';
import type { MMBinding, MMCtx, VideoFrameReq, VideoTaskResult, VideoTextReq } from '../types.js';
import { HttpError, pollIntervalOf, postJson, readProgress } from '../shared.js';

const POLL_TIMEOUT_MS = 30_000;

// ---------- Agnes 公共：POST /v1/videos 创建 + GET /agnesapi 轮询 ----------

function agnesQueryUrl(b: MMBinding, videoId: string, modelName?: string): string {
  return `${b.baseUrl.replace(/\/v1$/, '')}/agnesapi?video_id=${encodeURIComponent(videoId)}${modelName ? `&model_name=${encodeURIComponent(modelName)}` : ''}`;
}

/** Agnes 视频轮询（无超时上限，点停止即中断）；查询为 GET（端点不接受 POST，POST 会被静默拒绝） */
async function pollAgnesVideo(b: MMBinding, ctx: MMCtx, videoId: string, modelName: string | undefined, pollInterval: number, startedAt: number): Promise<string> {
  const pollUrl = agnesQueryUrl(b, videoId, modelName);
  let reportedQueued = false;
  while (true) {
    if (ctx.signal.aborted) throw new Error('已停止');
    if (!reportedQueued) ctx.report('视频生成中：排队中…');
    await new Promise((r) => setTimeout(r, pollInterval));
    const timeout = AbortSignal.timeout(POLL_TIMEOUT_MS);
    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${b.apiKey}` },
      signal: AbortSignal.any([ctx.signal, timeout]),
    }).catch(() => null);
    if (!res || !res.ok) continue;
    const status = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!status) continue;
    reportedQueued = true;
    const st = String(status?.status ?? '');
    const progress = readProgress(status);
    ctx.report(`视频生成中：${st || '处理中'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s${progress ? `，${progress}%` : ''}）`);
    if (st.toLowerCase() === 'failed') throw new Error(`视频生成失败：${JSON.stringify(status).slice(0, 300)}`);
    if (st.toLowerCase() === 'completed') {
      const meta = status?.metadata as Record<string, unknown> | null;
      const url = String(meta?.url ?? status?.url ?? status?.video_url ?? '');
      if (!url) throw new Error('视频生成完成但未返回视频 URL');
      return url;
    }
  }
}

async function agnesCreateAndPoll(b: MMBinding, ctx: MMCtx, body: Record<string, unknown>, describe: string, pollInterval: number, modelName?: string): Promise<VideoTaskResult> {
  ctx.report('视频任务创建中…');
  const created = await postJson(`${b.baseUrl}/videos`, b.apiKey, body, ctx.signal);
  const videoId = String(created?.video_id ?? created?.id ?? created?.task_id ?? '');
  if (!videoId) throw new Error('视频任务创建失败（未返回 video_id）');
  const taskId = String(created?.task_id ?? created?.id ?? '') || undefined;
  ctx.report(`视频任务已创建（video_id=${videoId}）`);
  const url = await pollAgnesVideo(b, ctx, videoId, modelName, pollInterval, Date.now());
  return { url, videoId, taskId, model: b.model, implementation: describe, queryUrl: agnesQueryUrl(b, videoId, modelName) };
}

// ---------- Agnes v2.0：旧格式 width/height/num_frames/frame_rate ----------

/** v2.0 宽高映射（服务端会把请求尺寸自动校正到最近预设，此处给合理值即可） */
function v2Dimensions(ratio: string): { width: number; height: number } {
  const map: Record<string, [number, number]> = {
    '16:9': [1152, 648],
    '9:16': [648, 1152],
    '1:1': [960, 960],
    '4:3': [1152, 864],
    '3:4': [864, 1152],
    '3:2': [1152, 768],
  };
  const [w, h] = map[ratio] ?? [1152, 648];
  return { width: w, height: h };
}

/** v2.0 帧数：24fps，钳制 1–12s，且满足官方 8n+1 规则（向上取整到最近合法值，时长不缩水） */
function v2NumFrames(seconds: string | undefined): number {
  const s = Math.min(12, Math.max(1, Number(seconds ?? '5') || 5));
  const raw = Math.round(s * 24);
  return Math.min(441, Math.max(9, Math.ceil((raw - 1) / 8) * 8 + 1));
}

/** 媒体源解析：Agnes 要求公开可访问 URL（本地路径不支持） */
function toMediaUrl(src: string): string {
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src;
  throw new Error('视频首帧/尾帧素材需提供 Agnes 服务可公开访问的 URL（本地路径不支持）');
}

const AGNES_V2_DESCRIBE = 'Agnes · v2.0 旧格式';

export const agnesV20Video = {
  async videoFromText(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult> {
    const { width, height } = v2Dimensions(req.aspectRatio ?? '16:9');
    // 旧格式不传 mode（官方文档 mode 可选）；轮询不带 model_name（默认模型）
    return agnesCreateAndPoll(b, ctx, { model: b.model, prompt: req.prompt, width, height, num_frames: v2NumFrames(req.seconds), frame_rate: 24 }, AGNES_V2_DESCRIBE, pollIntervalOf(req));
  },

  async videoFromFrame(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult> {
    const firstFrameUrl = toMediaUrl(req.firstFrame);
    // v2.0 不支持尾帧：传了直接明确报错
    if (req.lastFrame) {
      toMediaUrl(req.lastFrame);
      throw new Error('agnes-video-v2.0 不支持尾帧（lastFrame），仅支持首帧图生视频');
    }
    const { width, height } = v2Dimensions(req.aspectRatio ?? '16:9');
    return agnesCreateAndPoll(b, ctx, { model: b.model, prompt: req.prompt, image: firstFrameUrl, width, height, num_frames: v2NumFrames(req.seconds), frame_rate: 24 }, AGNES_V2_DESCRIBE, pollIntervalOf(req));
  },
};

// ---------- Agnes 2.5 家族（含 2.5-flash）：mode/size 档位 + mode 值自动探测 ----------
// mode 候选：新文档值（text/keyframe）→ 旧实测值（ti2vid/keyframes）。创建阶段 400（不建任务不计费）才换值重试；
// 成功值按 baseUrl+model+kind 进程内缓存，避免重复探测。

const MODE_CANDIDATES: Record<'text' | 'keyframe', string[]> = { text: ['text', 'ti2vid'], keyframe: ['keyframe', 'keyframes'] };
const modeCache = new Map<string, string>();

function isCreateRejected(e: unknown): boolean {
  return e instanceof HttpError && e.status === 400;
}

const AGNES_25_DESCRIBE = 'Agnes · 2.5 格式（含 2.5-flash）';

async function createWithModeProbe(
  b: MMBinding,
  ctx: MMCtx,
  kind: 'text' | 'keyframe',
  buildBody: (mode: string) => Record<string, unknown>,
  pollInterval: number,
): Promise<VideoTaskResult> {
  const cacheKey = `${b.baseUrl}|${b.model}|${kind}`;
  const candidates = modeCache.has(cacheKey) ? [modeCache.get(cacheKey)!] : MODE_CANDIDATES[kind];
  let lastErr: unknown;
  for (const mode of candidates) {
    try {
      const result = await agnesCreateAndPoll(b, ctx, buildBody(mode), AGNES_25_DESCRIBE, pollInterval, b.model);
      modeCache.set(cacheKey, mode);
      return result;
    } catch (e) {
      lastErr = e;
      if (!isCreateRejected(e) || ctx.signal.aborted) throw e;
    }
  }
  throw lastErr;
}

export const agnes25Video = {
  async videoFromText(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult> {
    const aspectRatio = req.aspectRatio ?? '16:9';
    return createWithModeProbe(b, ctx, 'text', (mode) => ({ model: b.model, prompt: req.prompt, seconds: String(req.seconds ?? '5'), mode, size: '720P', aspect_ratio: aspectRatio }), pollIntervalOf(req));
  },

  async videoFromFrame(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult> {
    const aspectRatio = req.aspectRatio ?? '16:9';
    const firstFrameUrl = toMediaUrl(req.firstFrame);
    const lastFrameUrl = req.lastFrame ? toMediaUrl(req.lastFrame) : undefined;
    return createWithModeProbe(
      b,
      ctx,
      'keyframe',
      (mode) => ({ model: b.model, prompt: req.prompt, seconds: String(req.seconds ?? '5'), mode, size: '720P', aspect_ratio: aspectRatio, first_frame: firstFrameUrl, ...(lastFrameUrl ? { last_frame: lastFrameUrl } : {}) }),
      pollIntervalOf(req),
    );
  },
};

// ---------- SiliconFlow：POST /video/submit + POST /video/status（requestId） ----------

const SF_DESCRIBE = 'SiliconFlow · 异步任务';

/** SF 视频轮询（状态值：Succeed / InQueue / InProgress / Failed；官方为 Succeed，兼容 succeeded/completed） */
async function pollSiliconflowVideo(b: MMBinding, ctx: MMCtx, requestId: string, pollInterval: number, startedAt: number): Promise<string> {
  while (true) {
    if (ctx.signal.aborted) throw new Error('已停止');
    await new Promise((r) => setTimeout(r, pollInterval));
    const status = await postJson(`${b.baseUrl}/video/status`, b.apiKey, { requestId }, ctx.signal, POLL_TIMEOUT_MS).catch(() => null);
    const st = String(status?.status ?? '');
    const progress = readProgress(status);
    ctx.report(`视频生成中：${st || '处理中'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s${progress ? `，${progress}%` : ''}）`);
    if (st.toLowerCase() === 'failed') throw new Error(`视频生成失败：${JSON.stringify(status).slice(0, 300)}`);
    if (['succeed', 'succeeded', 'completed'].includes(st.toLowerCase())) {
      const list = status?.results?.videos ?? status?.videos ?? [];
      const url = String(list[0]?.url ?? '');
      if (!url) throw new Error('视频生成完成但未返回视频 URL');
      return url;
    }
  }
}

/** 本地文件 → Data URI（SF 接受；URL/data 原样透传） */
function sfFirstFrame(src: string): string {
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src;
  return `data:image/png;base64,${readFileSync(src).toString('base64')}`;
}

async function sfSubmitAndPoll(b: MMBinding, ctx: MMCtx, body: Record<string, unknown>, pollInterval: number): Promise<VideoTaskResult> {
  ctx.report('视频任务创建中…');
  const submitted = await postJson(`${b.baseUrl}/video/submit`, b.apiKey, body, ctx.signal);
  const requestId = String(submitted?.requestId ?? '');
  if (!requestId) throw new Error('视频任务创建失败（未返回 requestId）');
  ctx.report(`视频任务已创建（requestId=${requestId}）`);
  const url = await pollSiliconflowVideo(b, ctx, requestId, pollInterval, Date.now());
  return { url, taskId: requestId, model: b.model, implementation: SF_DESCRIBE };
}

export const siliconflowVideo = {
  async videoFromText(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult> {
    return sfSubmitAndPoll(b, ctx, { model: b.model, prompt: req.prompt }, pollIntervalOf(req));
  },

  async videoFromFrame(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult> {
    const aspectRatio = req.aspectRatio ?? '16:9';
    const imageSize = aspectRatio === '9:16' ? '720x1280' : aspectRatio === '1:1' ? '960x960' : '1280x720';
    return sfSubmitAndPoll(b, ctx, { model: b.model, prompt: req.prompt, image_size: imageSize, image: sfFirstFrame(req.firstFrame) }, pollIntervalOf(req));
  },
};
