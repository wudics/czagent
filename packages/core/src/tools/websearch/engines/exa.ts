import type { AiSearchProvider, SearchResult } from '../types.js';
import { fetchJsonPost } from '../fetcher.js';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';

interface ExaResult {
  title?: string;
  url?: string;
  summary?: string;
  highlights?: string[];
  text?: string;
}

/**
 * Exa 检索（prompt-engineered query 的神经搜索，专为 LLM/agent 设计）。
 * text:false 只要 summary/highlights 摘要（全文交给 webfetch 二次抓取，控制成本）。
 */
export const exaProvider: AiSearchProvider = {
  id: 'exa',
  configKey: 'exa',
  async search({ query, maxResults, apiKey, signal }) {
    const json = (await fetchJsonPost(
      EXA_SEARCH_URL,
      { Authorization: `Bearer ${apiKey}` },
      {
        query,
        type: 'auto',
        numResults: Math.min(100, Math.max(1, maxResults)),
        contents: { text: false, highlights: { maxCharacters: 500 }, summary: {} },
      },
      signal,
    )) as { error?: string; tag?: string; results?: ExaResult[] };
    if (!Array.isArray(json.results)) {
      throw new Error(json.error ? `${json.error}${json.tag ? `（${json.tag}）` : ''}` : '响应缺少 results');
    }
    const out: SearchResult[] = [];
    for (const r of json.results) {
      const url = typeof r.url === 'string' ? r.url : '';
      if (!url.startsWith('http')) continue;
      const snippet = (r.summary ?? r.highlights?.[0] ?? r.text ?? '').trim();
      out.push({ title: (r.title ?? '').trim() || url, url, snippet });
    }
    return out;
  },
};
