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

self.onmessage = (e: MessageEvent<MarkdownRequest>) => {
  const { id, text } = e.data;
  try {
    const html = marked.parse(text, { async: false }) as string;
    (self as unknown as Worker).postMessage({ id, ok: true, html } satisfies MarkdownResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) } satisfies MarkdownResponse);
  }
};
