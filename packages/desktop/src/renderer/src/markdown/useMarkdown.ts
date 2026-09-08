import { useEffect, useRef, useState } from 'react';
import type { MarkdownRequest, MarkdownResponse } from './markdown.worker';

let worker: Worker | null = null;
const cache = new Map<string, string>();
const inflight = new Map<number, { text: string; resolve: (html: string) => void }>();
let reqId = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<MarkdownResponse>) => {
      const req = inflight.get(e.data.id);
      if (!req) return;
      inflight.delete(e.data.id);
      if (e.data.ok && e.data.html) {
        cache.set(req.text, e.data.html);
        if (cache.size > 300) {
          const first = cache.keys().next().value;
          if (first !== undefined) cache.delete(first);
        }
      }
      req.resolve(e.data.ok && e.data.html ? e.data.html : req.text);
    };
  }
  return worker;
}

function renderMarkdown(text: string): Promise<string> {
  const hit = cache.get(text);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const id = ++reqId;
    inflight.set(id, { text, resolve });
    getWorker().postMessage({ id, text } satisfies MarkdownRequest);
  });
}

/**
 * 将 markdown 渲染为 HTML（Web Worker，防主线程卡顿）。
 * 流式场景：以 60ms 防抖合并高频更新，期间返回上一次渲染结果（略滞后但流畅）。
 */
export function useMarkdown(text: string): string {
  const [html, setHtml] = useState<string>(() => cache.get(text) ?? '');
  const lastText = useRef(text);

  useEffect(() => {
    lastText.current = text;
    const hit = cache.get(text);
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
