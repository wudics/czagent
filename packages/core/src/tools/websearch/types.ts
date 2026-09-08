/** websearch：搜索结果与引擎接口（决策 17）。 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchEngine {
  id: 'bing' | 'baidu' | 'so360' | 'sogou';
  /** 构造第 page 页搜索 URL（page 从 1 开始） */
  buildUrl(query: string, page: number): string;
  /** 从 HTML 提取结果；被反爬/结构变化时返回 []（由编排层降级下一引擎） */
  parse(html: string): SearchResult[];
}
