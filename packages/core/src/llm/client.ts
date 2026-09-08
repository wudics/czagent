import type { ChatStreamRequest, LLMEvent } from './types.js';
import { LLMError, classifyHttpError } from './errors.js';
import { parseSse } from './sse.js';
import { normalizeUsage } from './usage.js';

const MAX_RETRIES = 2;

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const sec = Number(header);
  if (!Number.isNaN(sec)) return Math.max(0, sec) * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 200;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildBody(request: ChatStreamRequest): Record<string, unknown> {
  const messages = request.messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content ?? null };
    if (m.role === 'user' && m.images && m.images.length > 0) {
      base.content = [
        { type: 'text', text: m.content ?? '' },
        ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
      ];
    }
    if (m.role === 'assistant') {
      if (m.reasoning && request.reasoningPassthrough) {
        base[request.reasoningMessageField ?? 'reasoning_content'] = m.reasoning;
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        base.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
    } else if (m.role === 'tool' && m.toolCallId) {
      base.tool_call_id = m.toolCallId;
    }
    return base;
  });
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.thinkingParams?.(request.thinking) ?? {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...request.options,
  };
}

async function fetchOnce(request: ChatStreamRequest, attempt: number): Promise<Response> {
  const url = `${request.baseUrl}${request.path ?? '/chat/completions'}`;
  const body = JSON.stringify(buildBody(request));

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
        ...request.headers,
      },
      body,
      signal: request.signal,
    });
  } catch (err) {
    if (request.signal?.aborted) throw new LLMError('cancelled', '已取消', {});
    const e = new LLMError('network', String((err as Error)?.message ?? err), { retryable: true });
    if (attempt < MAX_RETRIES) {
      await sleep(backoffMs(attempt));
      return fetchOnce(request, attempt + 1);
    }
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const err = classifyHttpError(res.status, text, retryAfter);
    if (err.retryable && attempt < MAX_RETRIES) {
      await sleep(err.retryAfterMs ?? backoffMs(attempt));
      return fetchOnce(request, attempt + 1);
    }
    throw err;
  }
  return res;
}

/**
 * 统一 Chat 流：请求 OpenAI 兼容 chat/completions，产出 LLMEvent 事件流。
 */
export async function* streamChat(request: ChatStreamRequest): AsyncGenerator<LLMEvent> {
  const res = await fetchOnce(request, 0);
  if (!res.body) throw new LLMError('network', '响应无 body', {});

  const cancelBody = (): void => {
    try {
      void res.body?.cancel().catch(() => {});
    } catch {
      // ignore
    }
  };

  let callSeq = 0;
  try {
    const pendingTools = new Map<number, { callID: string; tool: string; input: string; announced: boolean }>();
    for await (const data of parseSse(res.body, request.signal)) {
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(data) as Record<string, any>;
      } catch {
        continue;
      }
      const choice = chunk?.choices?.[0];
      if (choice) {
        const delta = choice.delta ?? {};
        const reasoningField = request.reasoningField ?? 'reasoning_content';
        if (typeof delta[reasoningField] === 'string' && delta[reasoningField]) {
          yield { type: 'reasoning-delta', text: delta[reasoningField] };
        }
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text-delta', text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
            const idx = tc.index ?? 0;
            const cur = pendingTools.get(idx) ?? { callID: '', tool: '', input: '', announced: false };
            if (tc.id) cur.callID = tc.id;
            if (tc.function?.name) cur.tool = tc.function.name;
            if (tc.function?.arguments) {
              if (!cur.announced) {
                cur.announced = true;
                yield { type: 'tool-call-start', callID: cur.callID, tool: cur.tool };
              }
              cur.input += tc.function.arguments;
              yield { type: 'tool-call-delta', callID: cur.callID, text: tc.function.arguments };
            }
            pendingTools.set(idx, cur);
          }
        }
        if (choice.finish_reason) {
          if (choice.finish_reason === 'tool_calls') {
            for (const t of pendingTools.values()) {
              const name = t.tool.trim();
              const raw = t.input.trim();
              // 空工具名 或 参数非合法 JSON → 视为模型误发工具调用（内容按文本输出，避免卡死/误执行）
              if (!name) {
                if (raw) yield { type: 'text-delta', text: raw };
                continue;
              }
              let input: unknown = {};
              if (raw) {
                try {
                  input = JSON.parse(raw) as unknown;
                } catch {
                  yield { type: 'text-delta', text: raw };
                  continue;
                }
              }
              // 部分平台（如 siliconflow 托管模型）可能缺 tool_call id，补一个保证 call/result 配对
              const callID = t.callID || `call-${++callSeq}`;
              yield { type: 'tool-call', callID, tool: name, input };
            }
          }
          yield {
            type: 'finish',
            finishReason: choice.finish_reason,
            usage: chunk?.usage ? normalizeUsage(chunk.usage) : undefined,
          };
          // 一轮 LLM 的逻辑终点就是 finish：立即停止消费流，
          // 避免部分平台（如 siliconflow 托管模型）发完 tool_calls/finish 后流不关闭导致挂起
          cancelBody();
          return;
        }
      } else if (chunk?.usage) {
        yield { type: 'finish', finishReason: 'stop', usage: normalizeUsage(chunk.usage) };
        cancelBody();
        return;
      }
    }
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (request.signal?.aborted) throw new LLMError('cancelled', '已取消', {});
    throw new LLMError('unknown', String((err as Error)?.message ?? err), {});
  }
}
