/** Agnes 图像引擎：size 档位 + ratio + extra_body.image 图生图 + return_base64。支持文生图与图生图（edit）。 */
import { promises as fs } from 'node:fs';
import type { GenImage, ImageEditReq, ImageGenerateReq, MMEngine, MMBinding, MMCtx } from '../types.js';
import { IMAGE_TIMEOUT_MS, extractImageOutputs, postJson } from '../mm.js';

export const agnesImage: MMEngine = {
  async generate(b: MMBinding, ctx: MMCtx, req: ImageGenerateReq): Promise<GenImage[]> {
    const body = { model: b.model, prompt: req.prompt, size: req.size ?? '1K', ...(req.ratio ? { ratio: req.ratio } : {}), return_base64: true };
    const res = await postJson(`${b.baseUrl}/images/generations`, b.apiKey, body, ctx.signal, IMAGE_TIMEOUT_MS);
    return extractImageOutputs(res);
  },

  async edit(b: MMBinding, ctx: MMCtx, req: ImageEditReq): Promise<GenImage[]> {
    // 参考图：URL/data 原样，本地路径读文件转 data URI
    const imageData = await Promise.all(
      req.images.map(async (src) => (/^https?:\/\//.test(src) || src.startsWith('data:') ? src : `data:image/png;base64,${(await fs.readFile(src)).toString('base64')}`)),
    );
    const body = {
      model: b.model,
      prompt: req.prompt,
      size: req.size ?? '1K',
      ...(req.ratio ? { ratio: req.ratio } : {}),
      extra_body: { image: imageData, response_format: 'b64_json' },
    };
    const res = await postJson(`${b.baseUrl}/images/generations`, b.apiKey, body, ctx.signal, IMAGE_TIMEOUT_MS);
    return extractImageOutputs(res);
  },
};
