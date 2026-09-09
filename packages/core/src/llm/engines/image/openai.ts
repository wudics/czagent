/** OpenAI 兼容图像引擎（兜底）：image_size 精确像素。不支持图生图（edit 未实现 → 网关显式报错）。 */
import type { GenImage, ImageGenerateReq, MMEngine, MMBinding, MMCtx } from '../types.js';
import { IMAGE_TIMEOUT_MS, extractImageOutputs, postJson } from '../mm.js';

export const openaiImage: MMEngine = {
  async generate(b: MMBinding, ctx: MMCtx, req: ImageGenerateReq): Promise<GenImage[]> {
    const body = { model: b.model, prompt: req.prompt, image_size: req.size && /^\d+x\d+$/.test(req.size) ? req.size : '1024x1024', batch_size: 1 };
    const res = await postJson(`${b.baseUrl}/images/generations`, b.apiKey, body, ctx.signal, IMAGE_TIMEOUT_MS);
    return extractImageOutputs(res);
  },
};
