/** SiliconFlow 视频引擎：POST {baseUrl}/video/submit + POST /video/status（requestId）异步轮询。 */
import { readFileSync } from 'node:fs';
import type { MMBinding, MMCtx, MMEngine, VideoFrameReq, VideoTaskResult, VideoTextReq } from '../types.js';
import { pollIntervalOf, postJson, readProgress } from '../mm.js';

const DESCRIBE = 'SiliconFlow · 异步任务';

/** SF 视频轮询（状态值：Succeed / InQueue / InProgress / Failed；官方为 Succeed，兼容 succeeded/completed） */
async function pollSiliconflowVideo(b: MMBinding, ctx: MMCtx, requestId: string, pollInterval: number, startedAt: number): Promise<string> {
  while (true) {
    if (ctx.signal.aborted) throw new Error('已停止');
    await new Promise((r) => setTimeout(r, pollInterval));
    const status = await postJson(`${b.baseUrl}/video/status`, b.apiKey, { requestId }, ctx.signal, 30_000).catch(() => null);
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
  return { url, taskId: requestId, model: b.model, implementation: DESCRIBE };
}

export const siliconflowVideo: MMEngine = {
  async videoFromText(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult> {
    return sfSubmitAndPoll(b, ctx, { model: b.model, prompt: req.prompt }, pollIntervalOf(req));
  },

  async videoFromFrame(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult> {
    const aspectRatio = req.aspectRatio ?? '16:9';
    const imageSize = aspectRatio === '9:16' ? '720x1280' : aspectRatio === '1:1' ? '960x960' : '1280x720';
    return sfSubmitAndPoll(b, ctx, { model: b.model, prompt: req.prompt, image_size: imageSize, image: sfFirstFrame(req.firstFrame) }, pollIntervalOf(req));
  },
};
