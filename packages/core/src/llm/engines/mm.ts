/** 多模态引擎共享 HTTP/解析工具。postJson 失败抛 HttpError（status + 响应体前 300 字符）。 */
import type { GenImage } from './types.js';

export const IMAGE_TIMEOUT_MS = 360_000; // Agnes 官方建议 60–360s
export const VIDEO_POLL_INTERVAL_MS = 2_000;
export const MAX_GENERATED_BYTES = 64 * 1024 * 1024;

/** 带 HTTP 状态码的错误（探测/重试逻辑按状态码分流） */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`HTTP ${status}：${bodyText.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

export async function postJson(url: string, apiKey: string, body: unknown, signal?: AbortSignal, timeoutMs = 120_000): Promise<any> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: merged,
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return JSON.parse(text);
}

/** 下载 URL → base64 dataUrl */
export async function downloadAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_GENERATED_BYTES) throw new Error(`生成文件过大（${(buf.length / 1024 / 1024).toFixed(1)}MB）`);
  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  return `data:${mime.split(';')[0]};base64,${buf.toString('base64')}`;
}

/** 容错响应解析：兼容 data[0].b64_json / data[0].url / images[0].url */
export function extractImageOutputs(res: any): GenImage[] {
  const list: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res?.images) ? res.images : [];
  return list
    .map((item) => ({ b64: typeof item?.b64_json === 'string' && item.b64_json ? item.b64_json : undefined, url: typeof item?.url === 'string' && item.url ? item.url : undefined }))
    .filter((x) => x.b64 || x.url);
}

/** URL/B64 → dataUrl（url 下载转 base64，便于消息流直接显示） */
export async function toDataUrl(img: GenImage): Promise<string> {
  if (img.b64) return `data:image/png;base64,${img.b64}`;
  return downloadAsDataUrl(img.url!);
}

/** 容错读取进度百分比字段（Agnes/SF 文档未明确列出，有则显示） */
export function readProgress(status: unknown): number | undefined {
  const s = status as Record<string, unknown> | null;
  if (!s) return undefined;
  const raw = s.progress ?? s.percent ?? s.progress_pct ?? (typeof s.data === 'object' && s.data !== null ? (s.data as Record<string, unknown>).progress : undefined);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : undefined;
}

/** 轮询间隔（工具可传 pollIntervalMs 覆盖，主要供测试加速） */
export function pollIntervalOf(req: { pollIntervalMs?: number }): number {
  return req.pollIntervalMs ? Number(req.pollIntervalMs) : VIDEO_POLL_INTERVAL_MS;
}
