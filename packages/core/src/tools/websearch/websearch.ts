import type { ToolDef, ToolContext } from '../types.js';
import type { SearchEngine, SearchResult } from './types.js';
import { fetchSearchHtml, setFetchIntervalForTest } from './fetcher.js';
import { bingEngine } from './engines/bing.js';
import { baiduEngine } from './engines/baidu.js';
import { so360Engine } from './engines/so360.js';
import { sogouEngine } from './engines/sogou.js';

/** 引擎固定优先级（配置里的开关只决定启用集合，顺序按此表） */
const ENGINES: SearchEngine[] = [bingEngine, baiduEngine, so360Engine, sogouEngine];
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

export const websearchTool: ToolDef = {
  id: 'websearch',
  description:
    '搜索网页获取结果列表（标题/链接/摘要）；先搜索浏览结果，再对高匹配条目使用 webfetch 抓取详情页全文',
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
    const maxResults = Math.min(20, Math.max(1, ctx.settings.general?.websearch?.maxResults ?? DEFAULT_MAX_RESULTS));
    const engines = engineOrder(ctx.settings);
    if (engines.length === 0) return '网页搜索已在设置中停用全部引擎。';

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
      return '搜索不可用（所有引擎均失败），可改用 webfetch 工具直达已知 URL。';
    }
    const ranked = rankResults(collected, query).slice(0, maxResults);
    const lines = ranked.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`);
    return `搜索“${query}”（引擎：${usedEngine}，共 ${ranked.length} 条）：\n\n${lines.join('\n\n')}\n\n对高匹配结果可使用 webfetch 工具抓取详情页全文。`;
  },
};
