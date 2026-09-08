import type { SearchEngine, SearchResult } from '../types.js';
import { absoluteUrl, stripTags } from '../parse-util.js';

/** 百度：baidu.com/s?wd=&pn=（pn=0/10/20…）；链接多为 /link 跳转（webfetch follow 即可达真页） */
export const baiduEngine: SearchEngine = {
  id: 'baidu',
  buildUrl(query, page) {
    return `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${(page - 1) * 10}&rn=10`;
  },
  parse(html) {
    const out: SearchResult[] = [];
    // 以 <h3…<a href> 为锚切分结果块（百度结果容器 class 变化频繁，锚点相对稳定）
    const re = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const anchors: { url: string; title: string; start: number; end: number }[] = [];
    for (const m of html.matchAll(re)) {
      anchors.push({ url: m[1]!, title: stripTags(m[2]!), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      const url = absoluteUrl(a.url, 'https://www.baidu.com/');
      if (!url.startsWith('http') || !a.title) continue;
      const seg = html.slice(a.end, i + 1 < anchors.length ? anchors[i + 1]!.start : Math.min(html.length, a.end + 4000));
      const abstract =
        /<span[^>]*class="[^"]*content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(seg) ??
        /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(seg) ??
        /<p[^>]*>([\s\S]*?)<\/p>/i.exec(seg);
      out.push({ title: a.title, url, snippet: abstract ? stripTags(abstract[1]!) : '' });
    }
    return out;
  },
};
