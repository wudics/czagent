/** HTTP 请求原语：网络错误/可重试状态码自动重试（指数退避 + retry-after），协议无关。 */
import { LLMError, classifyHttpError } from '../errors.js';

const MAX_RETRIES = 2;

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const sec = Number(header);
  if (!Number.isNaN(sec)) return Math.max(0, sec) * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return date - Date.now();
  return undefined;
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 200;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单次 POST JSON 请求（自动重试）；signal 取消立即中断不重试 */
export async function fetchJsonWithRetry(url: string, body: unknown, apiKey: string, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
  return fetchWithRetry(url, init, signal);
}

export async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const attemptOnce = async (attempt: number): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      if (signal?.aborted) throw new LLMError('cancelled', '已取消', {});
      const e = new LLMError('network', String((err as Error)?.message ?? err), { retryable: true });
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        return attemptOnce(attempt + 1);
      }
      throw e;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const err = classifyHttpError(res.status, text, retryAfter);
      if (err.retryable && attempt < MAX_RETRIES) {
        await sleep(err.retryAfterMs ?? backoffMs(attempt));
        return attemptOnce(attempt + 1);
      }
      throw err;
    }
    return res;
  };
  return attemptOnce(0);
}
