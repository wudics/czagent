/** 向量/重排 profile 实现（OpenAI 兼容格式）。 */
import type { EmbedProfileImpl, MMBinding, MMCtx, RerankHit, RerankProfileImpl } from '../types.js';
import { postJson } from '../shared.js';

export const openaiEmbed: EmbedProfileImpl = {
  async embed(b: MMBinding, ctx: MMCtx, texts: string[]): Promise<number[][]> {
    const res = await postJson(`${b.baseUrl}/embeddings`, b.apiKey, { model: b.model, input: texts }, ctx.signal);
    const vectors = (res?.data ?? []).map((d: { embedding?: number[] }) => d.embedding ?? []);
    if (vectors.length === 0) throw new Error('embedding 响应为空');
    return vectors;
  },
};

export const openaiRerank: RerankProfileImpl = {
  async rerank(b: MMBinding, ctx: MMCtx, req: { query: string; documents: string[]; topN: number }): Promise<RerankHit[]> {
    const res = await postJson(`${b.baseUrl}/rerank`, b.apiKey, { model: b.model, query: req.query, documents: req.documents, top_n: req.topN }, ctx.signal);
    const results = (res?.results ?? []) as { index?: number; relevance_score?: number }[];
    return results.map((r) => ({ index: r.index ?? 0, score: r.relevance_score }));
  },
};
