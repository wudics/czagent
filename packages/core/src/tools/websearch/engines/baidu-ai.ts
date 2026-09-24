import type { AiSearchProvider, SearchResult } from '../types.js';
import { fetchJsonPost } from '../fetcher.js';

const BAIDU_SEARCH_URL = 'https://qianfan.baidubce.com/v2/ai_search/web_search';

/** query 计权长度（百度限制 72：一个汉字/全角字符占 2）→ 按权截断 */
function truncateByWeight(query: string, limit = 72): string {
  let weight = 0;
  let out = '';
  for (const ch of query) {
    const w = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff01\uff08-\uff09\uffe1-\uffe5\u3400-\u9fff]/.test(ch) ? 2 : 1;
    if (weight + w > limit) break;
    weight += w;
    out += ch;
  }
  return out.trim() || query.slice(0, limit);
}

interface BaiduReference {
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  website?: string;
  web_anchor?: string;
  date?: string;
  type?: string;
}

/** 千帆「百度 AI 搜索」web_search（结构化网页检索；月免 1500 次，按量后付费） */
export const baiduAiProvider: AiSearchProvider = {
  id: 'baidu-ai',
  configKey: 'baidu',
  async search({ query, maxResults, apiKey, signal }) {
    const json = (await fetchJsonPost(
      BAIDU_SEARCH_URL,
      { Authorization: `Bearer ${apiKey}` },
      {
        messages: [{ role: 'user', content: truncateByWeight(query) }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: Math.min(50, Math.max(1, maxResults)) }],
      },
      signal,
    )) as { code?: string; message?: string; references?: BaiduReference[] };
    if (json && (json.code || json.message)) throw new Error(`百度 AI 搜索失败：${json.code ?? ''} ${json.message ?? ''}`.trim());
    const out: SearchResult[] = [];
    for (const ref of json?.references ?? []) {
      const url = typeof ref.url === 'string' ? ref.url.trim() : '';
      if (!url.startsWith('http')) continue;
      const snippet = String(ref.snippet ?? ref.content ?? '').trim();
      out.push({ title: String(ref.title ?? ref.web_anchor ?? ref.website ?? '').trim() || url, url, snippet });
    }
    return out;
  },
};

export { truncateByWeight as truncateBaiduQuery };
