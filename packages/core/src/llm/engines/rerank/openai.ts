/** OpenAI 兼容重排引擎（兜底）：POST {baseUrl}/rerank。 */
import type { MMEngine, MMBinding, MMCtx, RerankReq } from '../types.js';
import { postJson } from '../mm.js';

export const openaiRerank: MMEngine = {
  async rerank(b: MMBinding, ctx: MMCtx, req: RerankReq): Promise<{ index: number; score?: number }[]> {
    const res = await postJson(`${b.baseUrl}/rerank`, b.apiKey, { model: b.model, query: req.query, documents: req.documents, top_n: req.topN }, ctx.signal);
    const results = (res?.results ?? []) as { index?: number; relevance_score?: number }[];
    return results.map((r) => ({ index: r.index ?? 0, score: r.relevance_score }));
  },
};
