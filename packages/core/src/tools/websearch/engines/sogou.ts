import type { SearchEngine, SearchResult } from '../types.js';
import { absoluteUrl, stripTags } from '../parse-util.js';

/** 搜狗：sogou.com/web?query=&page=；结果块 <div class="vrwrap">/<h3 class="vr-title">；链接多为 /link 跳转 */
export const sogouEngine: SearchEngine = {
  id: 'sogou',
  buildUrl(query, page) {
    return `https://www.sogou.com/web?query=${encodeURIComponent(query)}&page=${page}`;
  },
  parse(html) {
    const out: SearchResult[] = [];
    const blocks = html.split('<div class="vrwrap">').slice(1);
    for (const raw of blocks) {
      const end = raw.indexOf('<div class="page');
      const seg = end >= 0 ? raw.slice(0, end) : raw;
      const link = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(seg);
      if (!link) continue;
      const url = absoluteUrl(link[1]!, 'https://www.sogou.com/');
      const title = stripTags(link[2]!);
      if (!url.startsWith('http') || !title) continue;
      const snip = /<div[^>]*class="[^"]*(?:str-text-info|fz-mid)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(seg) ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(seg);
      out.push({ title, url, snippet: snip ? stripTags(snip[1]!) : '' });
    }
    return out;
  },
};
