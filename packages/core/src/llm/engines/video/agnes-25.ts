/** Agnes 视频引擎 · 2.5 家族（含 2.5-flash）：seconds/mode/size 档位 + mode 值自动探测。
 *  mode 候选：新文档值（text/keyframe）→ 旧实测值（ti2vid/keyframes）。创建阶段 400（不建任务不计费）才换值重试；
 *  成功值按 baseUrl+model+kind 进程内缓存，避免重复探测。 */
import type { MMBinding, MMCtx, MMEngine, VideoFrameReq, VideoTaskResult, VideoTextReq } from '../types.js';
import { pollIntervalOf } from '../mm.js';
import { agnesCreateAndPoll, toMediaUrl } from './agnes-common.js';
import { withModeProbe } from './probe.js';

const DESCRIBE = 'Agnes · 2.5 格式（含 2.5-flash）';

export const agnes25Video: MMEngine = {
  async videoFromText(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult> {
    const aspectRatio = req.aspectRatio ?? '16:9';
    return withModeProbe(b, ctx, 'text', (mode) => agnesCreateAndPoll(b, ctx, { model: b.model, prompt: req.prompt, seconds: String(req.seconds ?? '5'), mode, size: '720P', aspect_ratio: aspectRatio }, DESCRIBE, pollIntervalOf(req), b.model), pollIntervalOf(req));
  },

  async videoFromFrame(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult> {
    const aspectRatio = req.aspectRatio ?? '16:9';
    const firstFrameUrl = toMediaUrl(req.firstFrame);
    const lastFrameUrl = req.lastFrame ? toMediaUrl(req.lastFrame) : undefined;
    return withModeProbe(
      b,
      ctx,
      'keyframe',
      (mode) =>
        agnesCreateAndPoll(
          b,
          ctx,
          { model: b.model, prompt: req.prompt, seconds: String(req.seconds ?? '5'), mode, size: '720P', aspect_ratio: aspectRatio, first_frame: firstFrameUrl, ...(lastFrameUrl ? { last_frame: lastFrameUrl } : {}) },
          DESCRIBE,
          pollIntervalOf(req),
          b.model,
        ),
      pollIntervalOf(req),
    );
  },
};
