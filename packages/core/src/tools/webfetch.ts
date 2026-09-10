import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef, ToolContext } from './types.js';

/** 原始响应体上限（HTML 转文本后体积远小于原始页面，2MB 足够覆盖常规网页） */
const MAX_RAW_BYTES = 2 * 1024 * 1024;
/** 直接内联返回的文本上限；超过则全文落盘并返回预览（模型可用 read 分段读取） */
const INLINE_TEXT_CHARS = 2_000;

/** 极简 HTML→文本（去脚本/样式/标签，保留换行） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webfetchTool: ToolDef = {
  id: 'webfetch',
  description:
    '抓取 URL 并转为文本（HTML 自动去标签）。超过 2000 字符自动落盘并返回预览，用 read 分段读取全文路径。\n用法：仅抓取用户提到或与任务直接相关的 URL，不要猜测编造 URL；配合 websearch 使用（先搜索拿到链接，再抓详情页）。\n注意：失败（404/超时）时可用 websearch 换关键词换源；原始响应超 2MB 会拒绝抓取。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 URL' },
    },
    required: ['url'],
  },
  async execute(input, ctx: ToolContext) {
    const url = String(input.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http(s):// 开头');

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (czagent desktop agent)' },
      signal: ctx.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.arrayBuffer();
    if (raw.byteLength > MAX_RAW_BYTES) {
      return `内容过大（${(raw.byteLength / 1024).toFixed(0)}KB，超过 2MB 上限），未抓取。`;
    }
    const decoded = new TextDecoder().decode(raw);
    const text = contentType.includes('text/html') ? htmlToText(decoded) : decoded;
    if (text.length <= INLINE_TEXT_CHARS) return text;

    // 全文落盘 + 预览：请求侧/显示层截断不再造成内容永久丢失（模型可按需 read）
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const dir = join(ctx.tempDir ?? join(tmpdir(), 'czagent-webfetch'), ctx.sessionId);
    const filePath = join(dir, `webfetch-${hash}.txt`);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, text, 'utf8');
    return `${text.slice(0, INLINE_TEXT_CHARS)}\n…\n<网页全文共 ${text.length} 字符，已存至 ${filePath}，可用 read 工具分段读取该路径>`;
  },
};
