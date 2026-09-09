/** OpenAI 兼容向量引擎（兜底）：POST {baseUrl}/embeddings。 */
import type { MMEngine, MMBinding, MMCtx } from '../types.js';
import { postJson } from '../mm.js';

export const openaiEmbed: MMEngine = {
  async embed(b: MMBinding, ctx: MMCtx, texts: string[]): Promise<number[][]> {
    const res = await postJson(`${b.baseUrl}/embeddings`, b.apiKey, { model: b.model, input: texts }, ctx.signal);
    const vectors = (res?.data ?? []).map((d: { embedding?: number[] }) => d.embedding ?? []);
    if (vectors.length === 0) throw new Error('embedding 响应为空');
    return vectors;
  },
};
