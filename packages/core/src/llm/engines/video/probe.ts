/** Agnes 2.5 视频接口的 mode 值探测（text/keyframe 候选 → 400 才换值重试 → 成功值进程内缓存）。 */
import type { MMBinding, MMCtx, VideoTaskResult } from '../types.js';
import { HttpError } from '../mm.js';

type ModeKind = 'text' | 'keyframe';

const MODE_CANDIDATES: Record<ModeKind, string[]> = { text: ['text', 'ti2vid'], keyframe: ['keyframe', 'keyframes'] };
const modeCache = new Map<string, string>();

function isCreateRejected(e: unknown): boolean {
  return e instanceof HttpError && e.status === 400;
}

export async function withModeProbe(
  b: MMBinding,
  ctx: MMCtx,
  kind: ModeKind,
  run: (mode: string) => Promise<VideoTaskResult>,
  _pollInterval: number,
): Promise<VideoTaskResult> {
  const cacheKey = `${b.baseUrl}|${b.model}|${kind}`;
  const candidates = modeCache.has(cacheKey) ? [modeCache.get(cacheKey)!] : MODE_CANDIDATES[kind];
  let lastErr: unknown;
  for (const mode of candidates) {
    try {
      const result = await run(mode);
      modeCache.set(cacheKey, mode);
      return result;
    } catch (e) {
      lastErr = e;
      if (!isCreateRejected(e) || ctx.signal.aborted) throw e;
    }
  }
  throw lastErr;
}
