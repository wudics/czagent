/** Agnes 视频引擎 · v2.0 旧格式：width/height/num_frames/frame_rate；不支持尾帧。 */
import { type MMBinding, type MMCtx, type MMEngine, type VideoFrameReq, type VideoTaskResult, type VideoTextReq } from '../types.js';
import { pollIntervalOf, postJson } from '../mm.js';
import { agnesCreateAndPoll, toMediaUrl, v2Dimensions, v2NumFrames } from './agnes-common.js';

const DESCRIBE = 'Agnes · v2.0 旧格式';

export const agnesV20Video: MMEngine = {
  async videoFromText(b: MMBinding, ctx: MMCtx, req: VideoTextReq): Promise<VideoTaskResult> {
    const { width, height } = v2Dimensions(req.aspectRatio ?? '16:9');
    // 旧格式不传 mode（官方文档 mode 可选）；轮询不带 model_name（默认模型）
    return agnesCreateAndPoll(b, ctx, { model: b.model, prompt: req.prompt, width, height, num_frames: v2NumFrames(req.seconds), frame_rate: 24 }, DESCRIBE, pollIntervalOf(req));
  },

  async videoFromFrame(b: MMBinding, ctx: MMCtx, req: VideoFrameReq): Promise<VideoTaskResult> {
    const firstFrameUrl = toMediaUrl(req.firstFrame);
    // v2.0 不支持尾帧：传了直接明确报错
    if (req.lastFrame) {
      toMediaUrl(req.lastFrame);
      throw new Error('Agnes 视频 v2.0 不支持尾帧（lastFrame），仅支持首帧图生视频');
    }
    const { width, height } = v2Dimensions(req.aspectRatio ?? '16:9');
    return agnesCreateAndPoll(b, ctx, { model: b.model, prompt: req.prompt, image: firstFrameUrl, width, height, num_frames: v2NumFrames(req.seconds), frame_rate: 24 }, DESCRIBE, pollIntervalOf(req));
  },
};
