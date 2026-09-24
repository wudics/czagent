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

/** AI 检索调用参数（apiKey 已由编排层确认非空） */
export interface AiSearchRequest {
  query: string;
  /** 期望结果条数（各引擎内部再做钳制） */
  maxResults: number;
  apiKey: string;
  signal?: AbortSignal;
}

/** 专为 AI 设计的结构化检索（百度千帆 web_search / Exa）：JSON API，免 HTML 解析与抓取节流 */
export interface AiSearchProvider {
  id: 'baidu-ai' | 'exa';
  /** general.websearch.ai 下的配置键（baidu-ai → ai.baidu，exa → ai.exa） */
  configKey: 'baidu' | 'exa';
  /** 失败抛错由编排层静默降级下一引擎 */
  search(req: AiSearchRequest): Promise<SearchResult[]>;
}
