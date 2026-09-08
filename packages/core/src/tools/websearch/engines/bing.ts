import type { SearchEngine, SearchResult } from '../types.js';
import { absoluteUrl, decodeUrl, stripTags } from '../parse-util.js';

/** 国内 Bing：cn.bing.com/search?q=&first=（first=1/11/21…）；结果块 <li class="b_algo"> */
export const bingEngine: SearchEngine = {
  id: 'bing',
  buildUrl(query, page) {
    return `https://cn.bing.com/search?q=${encodeURIComponent(query)}&first=${(page - 1) * 10 + 1}&mkt=zh-CN`;
  },
  parse(html) {
    const out: SearchResult[] = [];
    const blocks = html.split('<li class="b_algo"').slice(1);
    for (const raw of blocks) {
      const end = raw.indexOf('</li>');
      const seg = end >= 0 ? raw.slice(0, end) : raw;
      const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(seg);
      if (!link) continue;
      const url = absoluteUrl(link[1]!, 'https://cn.bing.com/');
      const title = stripTags(link[2]!);
      if (!url.startsWith('http') || !title) continue;
      const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(seg);
      out.push({ title, url: decodeUrl(url), snippet: snip ? stripTags(snip[1]!) : '' });
    }
    return out;
  },
};
