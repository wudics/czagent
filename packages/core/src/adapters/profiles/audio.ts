/** 语音 profile 实现（OpenAI 兼容格式）：TTS（voice 必填 <model>:<音色>，简写自动补前缀）与 ASR（multipart）。 */
import type { AsrProfileImpl, MMBinding, MMCtx, TtsProfileImpl } from '../types.js';

export const openaiTts: TtsProfileImpl = {
  async tts(b: MMBinding, ctx: MMCtx, req: { text: string; voice?: string }): Promise<Buffer> {
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

export const openaiAsr: AsrProfileImpl = {
  async asr(b: MMBinding, ctx: MMCtx, req: { buffer: Buffer; filename: string }): Promise<string> {
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
