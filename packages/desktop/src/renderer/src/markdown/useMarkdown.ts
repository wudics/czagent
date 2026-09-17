import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { MarkdownRequest, MarkdownResponse } from './markdown.worker';

let worker: Worker | null = null;
const cache = new Map<string, string>();
const inflight = new Map<number, { text: string; resolve: (html: string) => void }>();
let reqId = 0;

/** 消毒配置（对齐 opencode）：仅保留 HTML profile，禁 style/script/iframe 等高危标签；
 * DOMPurify 默认已剥离事件处理器属性。worker 无 DOM，消毒在主线程响应处做一次并缓存 */
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['srcset'],
};

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
}

/** 纯文本转义（markdown 解析失败时的回退显示，避免原始 HTML 被直接注入） */
export function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function cachePut(text: string, html: string): void {
  cache.delete(text);
  cache.set(text, html);
  if (cache.size > 300) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function cacheGet(text: string): string | undefined {
  const v = cache.get(text);
  if (v !== undefined) {
    cache.delete(text);
    cache.set(text, v);
  }
  return v;
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<MarkdownResponse>) => {
      const req = inflight.get(e.data.id);
      if (!req) return;
      inflight.delete(e.data.id);
      if (e.data.ok && e.data.html) {
        // 消毒后再缓存/交付：同一文本只消毒一次
        const clean = sanitize(e.data.html);
        cachePut(req.text, clean);
        req.resolve(clean);
      } else {
        // 解析失败回退：转义后的纯文本（不缓存，下次流式更新会重试）
        req.resolve(escapeHtmlText(req.text));
      }
    };
  }
  return worker;
}

function renderMarkdown(text: string): Promise<string> {
  const hit = cacheGet(text);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const id = ++reqId;
    inflight.set(id, { text, resolve });
    getWorker().postMessage({ id, text } satisfies MarkdownRequest);
  });
}

/**
 * 将 markdown 渲染为 HTML（Web Worker 解析 + DOMPurify 消毒，防主线程卡顿/HTML 注入）。
 * 流式场景：以 60ms 防抖合并高频更新，期间返回上一次渲染结果（略滞后但流畅）；
 * worker 内按块缓存，流式期间只重解析尾部块。
 */
export function useMarkdown(text: string): string {
  const [html, setHtml] = useState<string>(() => cacheGet(text) ?? '');
  const lastText = useRef(text);

  useEffect(() => {
    lastText.current = text;
    const hit = cacheGet(text);
    if (hit) {
      setHtml(hit);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      void renderMarkdown(text).then((h) => {
        if (!cancelled) setHtml(h);
      });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [text]);

  return html;
}
