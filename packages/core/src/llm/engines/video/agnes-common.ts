/** Agnes 视频引擎公共部分：POST {baseUrl}/videos 创建 + GET /agnesapi 轮询 + v2.0 尺寸/帧数换算。 */
import type { MMBinding, MMCtx, VideoTaskResult } from '../types.js';
import { postJson, readProgress } from '../mm.js';

const POLL_TIMEOUT_MS = 30_000;

export function agnesQueryUrl(b: MMBinding, videoId: string, modelName?: string): string {
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

export async function agnesCreateAndPoll(b: MMBinding, ctx: MMCtx, body: Record<string, unknown>, describe: string, pollInterval: number, modelName?: string): Promise<VideoTaskResult> {
  ctx.report('视频任务创建中…');
  const created = await postJson(`${b.baseUrl}/videos`, b.apiKey, body, ctx.signal);
  const videoId = String(created?.video_id ?? created?.id ?? created?.task_id ?? '');
  if (!videoId) throw new Error('视频任务创建失败（未返回 video_id）');
  const taskId = String(created?.task_id ?? created?.id ?? '') || undefined;
  ctx.report(`视频任务已创建（video_id=${videoId}）`);
  const url = await pollAgnesVideo(b, ctx, videoId, modelName, pollInterval, Date.now());
  return { url, videoId, taskId, model: b.model, implementation: describe, queryUrl: agnesQueryUrl(b, videoId, modelName) };
}

/** v2.0 宽高映射（服务端会把请求尺寸自动校正到最近预设，此处给合理值即可） */
export function v2Dimensions(ratio: string): { width: number; height: number } {
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
export function v2NumFrames(seconds: string | undefined): number {
  const s = Math.min(12, Math.max(1, Number(seconds ?? '5') || 5));
  const raw = Math.round(s * 24);
  return Math.min(441, Math.max(9, Math.ceil((raw - 1) / 8) * 8 + 1));
}

/** 媒体源解析：Agnes 要求公开可访问 URL（本地路径不支持） */
export function toMediaUrl(src: string): string {
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src;
  throw new Error('视频首帧/尾帧素材需提供 Agnes 服务可公开访问的 URL（本地路径不支持）');
}
