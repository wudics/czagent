/** OpenAI 兼容 ASR 引擎（兜底）：multipart 上传音频文件转文本。 */
import type { AsrReq, MMEngine, MMBinding, MMCtx } from '../types.js';

export const openaiAsr: MMEngine = {
  async asr(b: MMBinding, ctx: MMCtx, req: AsrReq): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(req.buffer)], { type: 'audio/mpeg' }), req.filename);
    form.append('model', b.model);
    const timeout = AbortSignal.timeout(120_000);
    const res = await fetch(`${b.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.apiKey}` },
      body: form,
      signal: AbortSignal.any([ctx.signal, timeout]),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as { text?: string };
    return parsed.text ?? text;
  },
};
