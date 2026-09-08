/** websearch 解析工具：剥标签 / 实体解码（容错优先，提取不到即跳过）。 */

/** 剥掉标签并折叠空白 */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** URL 实体解码（&amp; 等） */
export function decodeUrl(url: string): string {
  return url.replace(/&amp;/g, '&').trim();
}

/** 相对链接补全 */
export function absoluteUrl(url: string, base: string): string {
  const u = decodeUrl(url);
  if (/^https?:\/\//i.test(u)) return u;
  return new URL(u, base).toString();
}
