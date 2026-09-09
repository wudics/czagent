/** OpenAI 兼容 TTS 引擎（兜底）：voice 必填 <model>:<音色>，简写自动补前缀。 */
import type { MMEngine, MMBinding, MMCtx, TtsReq } from '../types.js';

export const openaiTts: MMEngine = {
  async tts(b: MMBinding, ctx: MMCtx, req: TtsReq): Promise<Buffer> {
    // voice 必填（格式 <model>:<音色>）；未传默认 alex；简写（不含 :）自动补模型前缀
    const rawVoice = String(req.voice ?? '').trim();
    const voice = rawVoice.includes(':') ? rawVoice : `${b.model}:${rawVoice || 'alex'}`;
    const timeout = AbortSignal.timeout(120_000);
    const res = await fetch(`${b.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: b.model, input: req.text, voice, response_format: 'mp3' }),
      signal: AbortSignal.any([ctx.signal, timeout]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  },
};
