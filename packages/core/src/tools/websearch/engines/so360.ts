import type { SearchEngine, SearchResult } from '../types.js';
import { absoluteUrl, stripTags } from '../parse-util.js';

/** 360 搜索：so.com/s?q=&pn=（pn=1/2/3…）；结果块 <li class="res-list"> */
export const so360Engine: SearchEngine = {
  id: 'so360',
  buildUrl(query, page) {
    return `https://www.so.com/s?q=${encodeURIComponent(query)}&pn=${page}`;
  },
  parse(html) {
    const out: SearchResult[] = [];
    const blocks = html.split('res-list').slice(1);
    for (const raw of blocks) {
      const end = raw.indexOf('</li>');
      const seg = end >= 0 ? raw.slice(0, end) : raw;
      const link = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(seg);
      if (!link) continue;
      const url = absoluteUrl(link[1]!, 'https://www.so.com/');
      const title = stripTags(link[2]!);
      if (!url.startsWith('http') || !title) continue;
      const snip =
        /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(seg) ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(seg);
      out.push({ title, url, snippet: snip ? stripTags(snip[1]!) : '' });
    }
    return out;
  },
};
