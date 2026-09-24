import type { ToolDef, ToolContext } from '../types.js';
import type { AiSearchProvider, SearchEngine, SearchResult } from './types.js';
import { fetchSearchHtml, setFetchIntervalForTest } from './fetcher.js';
import { bingEngine } from './engines/bing.js';
import { baiduEngine } from './engines/baidu.js';
import { so360Engine } from './engines/so360.js';
import { sogouEngine } from './engines/sogou.js';
import { baiduAiProvider } from './engines/baidu-ai.js';
import { exaProvider } from './engines/exa.js';

/** HTML 抓取引擎固定优先级（配置里的开关只决定启用集合，顺序按此表） */
const ENGINES: SearchEngine[] = [bingEngine, baiduEngine, so360Engine, sogouEngine];
/** AI 结构化检索优先于 HTML 抓取；未启用/失败逐级降级，全败落 ENGINES 兜底 */
const AI_PROVIDERS: AiSearchProvider[] = [baiduAiProvider, exaProvider];
const MAX_PAGES = 3;
const DEFAULT_MAX_RESULTS = 8;

export { setFetchIntervalForTest };

/** query 分词：英数单词 + CJK 单字（用于标题/摘要命中打分） */
function tokenize(query: string): string[] {
  const q = query.toLowerCase();
  const terms = new Set<string>();
  for (const m of q.matchAll(/[a-z0-9]+/g)) terms.add(m[0]);
  for (const ch of q) if (/[\u3400-\u9fff]/.test(ch)) terms.add(ch);
  if (terms.size === 0) terms.add(q);
  return [...terms];
}

function rankResults(results: SearchResult[], query: string): SearchResult[] {
  const terms = tokenize(query);
  const score = (r: SearchResult): number => {
    const t = r.title.toLowerCase();
    const s = r.snippet.toLowerCase();
    let n = 0;
    for (const term of terms) {
      if (t.includes(term)) n += 3;
      if (s.includes(term)) n += 1;
    }
    return n;
  };
  return [...results].sort((a, b) => score(b) - score(a));
}

function engineOrder(settings: ToolContext['settings']): SearchEngine[] {
  // 未配置（undefined）→ 全部启用；显式空数组 → 全部停用（设置页可关闭所有引擎）
  const enabled = settings.general?.websearch?.engines;
  const ids = enabled ?? ENGINES.map((e) => e.id);
  return ENGINES.filter((e) => ids.includes(e.id));
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

function formatResults(query: string, engine: string, ranked: SearchResult[]): string {
  const lines = ranked.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`);
  return `搜索“${query}”（引擎：${engine}，共 ${ranked.length} 条）：\n\n${lines.join('\n\n')}\n\n对高匹配结果可使用 webfetch 工具抓取详情页全文。`;
}

export const websearchTool: ToolDef = {
  id: 'websearch',
  description:
    '联网搜索，返回结果列表（标题/链接/摘要；优先 AI 结构化检索，未启用时多引擎 HTML 聚合去重）。适合调研类、时效性问题（新技术/版本/文档/新闻）。\n用法：query 用具体关键词，可从不同角度多次搜索；先搜索浏览结果，再对高匹配条目用 webfetch 抓取详情页全文。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
    },
    required: ['query'],
  },
  async execute(input, ctx: ToolContext) {
    const query = String(input.query ?? '').trim();
    if (!query) throw new Error('缺少 query 参数');
    const wsSettings = ctx.settings.general?.websearch;
    const maxResults = Math.min(20, Math.max(1, wsSettings?.maxResults ?? DEFAULT_MAX_RESULTS));
    const engines = engineOrder(ctx.settings);

    // 1) AI 结构化检索（级联）：首个有结果即止；未配置 key/关闭/失败静默降级
    for (const provider of AI_PROVIDERS) {
      const cfg = wsSettings?.ai?.[provider.configKey];
      if (!cfg?.enabled || !cfg.apiKey?.trim()) continue;
      let results: SearchResult[];
      try {
        results = await provider.search({ query, maxResults, apiKey: cfg.apiKey.trim(), signal: ctx.signal });
      } catch {
        continue;
      }
      const unique = dedupeByUrl(results);
      if (unique.length === 0) continue;
      const ranked = rankResults(unique, query).slice(0, maxResults);
      return formatResults(query, provider.id, ranked);
    }

    // 2) HTML 抓取兜底：原多引擎翻页逻辑
    if (engines.length === 0) {
      return '网页搜索已无可用引擎（AI 检索未启用或失败，HTML 引擎已在设置中全部停用）。';
    }
    const seen = new Set<string>();
    const collected: SearchResult[] = [];
    let usedEngine = '';
    for (const engine of engines) {
      const pageResults: SearchResult[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        let html: string;
        try {
          html = await fetchSearchHtml(engine.buildUrl(query, page), ctx.signal);
        } catch {
          break; // 网络失败/中断 → 换下一引擎
        }
        const parsed = engine.parse(html).filter((r) => r.url && !seen.has(r.url));
        for (const r of parsed) {
          seen.add(r.url);
          pageResults.push(r);
        }
        if (pageResults.length >= maxResults) break;
        if (parsed.length === 0) break; // 首页解析为空（反爬/结构变化）或翻页无新结果 → 停止翻页
      }
      if (pageResults.length > 0) {
        collected.push(...pageResults);
        usedEngine = engine.id;
        break; // 首个有结果的引擎即止
      }
    }

    if (collected.length === 0) {
      return '搜索不可用（AI 检索失败或未启用，HTML 引擎亦全部失败），可改用 webfetch 工具直达已知 URL。';
    }
    const ranked = rankResults(collected, query).slice(0, maxResults);
    return formatResults(query, usedEngine, ranked);
  },
};
