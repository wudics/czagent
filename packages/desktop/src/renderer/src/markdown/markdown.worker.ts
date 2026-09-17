import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export interface MarkdownRequest {
  id: number;
  text: string;
}

export interface MarkdownResponse {
  id: number;
  ok: boolean;
  html?: string;
  error?: string;
}

/**
 * 块级增量渲染（对齐 opencode markdown-stream 思路）：
 * marked.lexer 切出顶层块后逐块解析，块源串哈希为键做 LRU 缓存——
 * 流式期间已完成的前缀块全部命中缓存，只重解析最后一个未闭合块，
 * 整条流的重解析成本从 O(全文) 降为 O(尾部块)。
 */
const blockCache = new Map<string, string>();
const BLOCK_CACHE_MAX = 800;

function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}:${s.length.toString(36)}`;
}

function cacheGet(key: string): string | undefined {
  const v = blockCache.get(key);
  if (v !== undefined) {
    // 命中重插 = 真 LRU（此前 FIFO 会把热块挤掉）
    blockCache.delete(key);
    blockCache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, html: string): void {
  blockCache.delete(key);
  blockCache.set(key, html);
  if (blockCache.size > BLOCK_CACHE_MAX) {
    const oldest = blockCache.keys().next().value;
    if (oldest !== undefined) blockCache.delete(oldest);
  }
}

function parseBlock(raw: string): string {
  const key = hashOf(raw);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const html = marked.parse(raw, { async: false }) as string;
  cacheSet(key, html);
  return html;
}

function render(text: string): string {
  const tokens = marked.lexer(text);
  let out = '';
  for (const tok of tokens) {
    out += parseBlock(tok.raw ?? '');
  }
  return out;
}

self.onmessage = (e: MessageEvent<MarkdownRequest>) => {
  const { id, text } = e.data;
  try {
    const html = render(text);
    (self as unknown as Worker).postMessage({ id, ok: true, html } satisfies MarkdownResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) } satisfies MarkdownResponse);
  }
};
