/** websearch 抓取：浏览器 UA + 全局节流 + 编码检测（UTF-8/GBK）。 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let intervalMs = 2_000;
let lastFetchAt = 0;

/** 请求间隔（毫秒）；仅供测试调整，正常使用保持 2s 防反爬 */
export function setFetchIntervalForTest(ms: number): void {
  intervalMs = ms;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** 从 content-type 或 HTML meta 嗅探 charset；gbk/gb2312 用 GBK 解码，其余 UTF-8 */
function decodeHtml(buffer: ArrayBuffer, contentType: string): string {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, 4096));
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? '';
  const charset = declared.toLowerCase();
  if (charset.includes('gb2312') || charset.includes('gbk') || charset.includes('gb18030')) {
    return new TextDecoder('gbk').decode(buffer);
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/** 抓取搜索页 HTML（节流 ≤1 次/intervalMs；中断/超时抛错由编排层降级处理） */
export async function fetchSearchHtml(url: string, signal?: AbortSignal): Promise<string> {
  const wait = lastFetchAt + intervalMs - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastFetchAt = Date.now();

  const timeout = AbortSignal.timeout(15_000);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: merged,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  return decodeHtml(buffer, res.headers.get('content-type') ?? '');
}
