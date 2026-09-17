/**
 * OpenAI 兼容 chat 协议原语（各 chat 引擎共享的底层机制，非任何一家专属）：
 * 消息/请求体组装、SSE 流 → LLMEvent。各引擎文件内只写自己的差异
 * （thinking 参数、reasoning 字段名等），通过参数注入。
 */
import type { ThinkingMode } from '../../provider.js';
import { LLMError } from '../errors.js';
import { parseSse } from '../sse.js';
import { normalizeUsage } from '../usage.js';
import type { ChatBinding, ChatReq, ChatEngine, LLMChatMessage, LLMEvent } from '../types.js';
import { fetchJsonWithRetry } from './http.js';

export const OPENAI_CHAT_PATH = '/chat/completions';

/** 规范化工具名：去首尾空白、剥 functions. 前缀与 :N 后缀（部分平台的命名修饰会导致"未知工具"误判） */
export function normalizeToolName(name: string): string {
  return name.trim().replace(/^functions\./, '').replace(/:\d+$/, '');
}

export interface OpenAiChatOptions {
  /** 流式 delta 中承载思考内容的字段（默认 reasoning_content） */
  reasoningField?: string;
  /** 回传历史 assistant 思考内容时使用的字段 */
  reasoningMessageField?: string;
  /** 是否必须回传 reasoning（DeepSeek 工具场景 400 规则） */
  reasoningPassthrough?: boolean;
  /** 思考模式 → 追加到请求体的参数（写死在各自引擎文件内） */
  thinkingParams(mode: ThinkingMode): Record<string, unknown> | undefined;
}

/** 业务消息 → OpenAI 格式 messages 数组（图片 content 块、assistant reasoning/toolCalls 回传、tool 配对） */
export function buildOpenAiMessages(
  messages: LLMChatMessage[],
  opts: { reasoningMessageField?: string; reasoningPassthrough?: boolean } = {},
): Record<string, unknown>[] {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content ?? null };
    if (m.role === 'user' && m.images && m.images.length > 0) {
      base.content = [
        { type: 'text', text: m.content ?? '' },
        ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
      ];
    }
    if (m.role === 'assistant') {
      if (m.reasoning && opts.reasoningPassthrough) {
        base[opts.reasoningMessageField ?? 'reasoning_content'] = m.reasoning;
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
}

/** 组装 OpenAI 兼容 chat 请求体并发出（自动重试）；各引擎在 thinkingParams 里注入差异 */
export async function openAiChatFetch(b: ChatBinding, req: ChatReq, opts: OpenAiChatOptions): Promise<Response> {
  const body: Record<string, unknown> = {
    model: b.modelName,
    messages: buildOpenAiMessages(req.messages, opts),
    stream: true,
    stream_options: { include_usage: true },
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(opts.thinkingParams(req.thinking) ?? {}),
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    ...req.options,
  };
  return fetchJsonWithRetry(`${b.baseUrl}${OPENAI_CHAT_PATH}`, body, b.apiKey, req.signal);
}

/** 消费 OpenAI 兼容 SSE 流 → LLMEvent（tool-call 增量聚合、usage 归一化、finish 即断流） */
export async function* consumeOpenAiStream(res: Response, signal: AbortSignal | undefined, reasoningField = 'reasoning_content'): AsyncGenerator<LLMEvent> {
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
    // flush 已聚合的工具调用 → tool-call 事件（任意 finish 路径共用）
    const flushPendingTools = function* (): Generator<LLMEvent> {
      for (const t of pendingTools.values()) {
        const name = normalizeToolName(t.tool);
        const raw = t.input.trim();
        // 空工具名 或 参数非合法 JSON → 仍产出 tool-call（带 parseError 标记），由调用方
        // 合成错误结果回传模型自我纠正；不再降级为文本导致调用被丢弃、turn 无声终止
        if (!name) {
          const callID = t.callID || `call-${++callSeq}`;
          yield { type: 'tool-call', callID, tool: '', input: raw, parseError: raw ? 'empty tool name' : 'empty tool name and arguments' };
          continue;
        }
        let input: unknown = {};
        let parseError: string | undefined;
        if (raw) {
          try {
            input = JSON.parse(raw) as unknown;
          } catch (e) {
            input = raw;
            parseError = String((e as Error)?.message ?? e);
          }
        }
        // 部分平台（如 siliconflow 托管模型）可能缺 tool_call id，补一个保证 call/result 配对
        const callID = t.callID || `call-${++callSeq}`;
        yield { type: 'tool-call', callID, tool: name, input, ...(parseError ? { parseError } : {}) };
      }
    };
    for await (const data of parseSse(res.body, signal)) {
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(data) as Record<string, any>;
      } catch {
        continue;
      }
      const choice = chunk?.choices?.[0];
      if (choice) {
        const delta = choice.delta ?? {};
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
            // id+name 均已知（可分块后到）才宣告 start：调用方流中即建 pending 卡片；
            // 任一缺失不宣告（callID 是调用方 upsert/去重键，避免空键/空名产生残缺卡片）
            const ready = cur.callID !== '' && cur.tool.trim() !== '';
            if (ready && !cur.announced) {
              cur.announced = true;
              yield { type: 'tool-call-start', callID: cur.callID, tool: normalizeToolName(cur.tool) };
            }
            if (tc.function?.arguments) {
              cur.input += tc.function.arguments;
              if (ready) yield { type: 'tool-call-delta', callID: cur.callID, text: tc.function.arguments };
            }
            pendingTools.set(idx, cur);
          }
        }
        if (choice.finish_reason) {
          // 任意 finish_reason 都 flush 已聚合的工具调用：部分 OpenAI 兼容平台（GLM/Qwen 部署）
          // 在流出 tool_calls 增量后回 finish_reason=stop，只认 tool_calls 会把调用静默丢弃，
          // 导致 loop 误以为无工具可执行而终止（对齐 opencode：stop+有工具调用也要继续）
          yield* flushPendingTools();
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
        // 无 choices 的纯 usage 终帧：同样 flush（部分平台以此收尾且此前无 finish_reason）
        yield* flushPendingTools();
        yield { type: 'finish', finishReason: 'stop', usage: normalizeUsage(chunk.usage) };
        cancelBody();
        return;
      }
    }
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (signal?.aborted) throw new LLMError('cancelled', '已取消', {});
    throw new LLMError('unknown', String((err as Error)?.message ?? err), {});
  }
}

/** 组装 + 请求 + 消费的通用管道：各 chat 引擎只需提供自己的差异参数 */
export async function* streamOpenAiChat(b: ChatBinding, req: ChatReq, opts: OpenAiChatOptions): AsyncGenerator<LLMEvent> {
  const res = await openAiChatFetch(b, req, opts);
  yield* consumeOpenAiStream(res, req.signal, opts.reasoningField ?? 'reasoning_content');
}

export type { ChatEngine };
