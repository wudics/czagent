/** 图像 profile 实现：agnes-image（size 档位 + extra_body.image 图生图 + return_base64）、openai-image（image_size 精确像素）。 */
import { promises as fs } from 'node:fs';
import type { GenImage, ImageProfileImpl, MMBinding, MMCtx } from '../types.js';
import { IMAGE_TIMEOUT_MS, extractImageOutputs, postJson } from '../shared.js';

export const agnesImage: ImageProfileImpl = {
  async generate(b: MMBinding, ctx: MMCtx, req: { prompt: string; size?: string; ratio?: string }): Promise<GenImage[]> {
    const body = { model: b.model, prompt: req.prompt, size: req.size ?? '1K', ...(req.ratio ? { ratio: req.ratio } : {}), return_base64: true };
    const res = await postJson(`${b.baseUrl}/images/generations`, b.apiKey, body, ctx.signal, IMAGE_TIMEOUT_MS);
    return extractImageOutputs(res);
  },

  async edit(b: MMBinding, ctx: MMCtx, req: { prompt: string; images: string[]; size?: string; ratio?: string }): Promise<GenImage[]> {
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

export const openaiImage: ImageProfileImpl = {
  async generate(b: MMBinding, ctx: MMCtx, req: { prompt: string; size?: string; ratio?: string }): Promise<GenImage[]> {
    const body = { model: b.model, prompt: req.prompt, image_size: req.size && /^\d+x\d+$/.test(req.size) ? req.size : '1024x1024', batch_size: 1 };
    const res = await postJson(`${b.baseUrl}/images/generations`, b.apiKey, body, ctx.signal, IMAGE_TIMEOUT_MS);
    return extractImageOutputs(res);
  },
  // edit 不提供：image-edit 能力在 openai 风格下由 registry 解析时报错换绑
};
