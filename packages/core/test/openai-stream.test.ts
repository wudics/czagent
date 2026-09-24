/** agent loop 加固相关纯函数/流协议测试：任意 finish flush 工具调用、畸形参数产出 parseError、工具名规范化、估算辅助。 */
import { describe, expect, it } from 'vitest';
import type { LLMEvent } from '../src/llm/types.js';
import { consumeOpenAiStream, normalizeToolName } from '../src/llm/engines/openai-stream.js';
import { estimateToolsTokens, TOOL_RESULT_TRUNCATE_MARKER, truncateToolOutput } from '../src/compaction.js';

/** OpenAI chat/completions SSE chunk 构造 */
function sseResponse(chunks: object[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function toolDelta(index: number, patch: { id?: string; name?: string; args?: string }): object {
  const fn: Record<string, string> = {};
  if (patch.name) fn.name = patch.name;
  if (patch.args !== undefined) fn.arguments = patch.args;
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(patch.id ? { id: patch.id } : {}),
              ...(Object.keys(fn).length > 0 ? { function: fn } : {}),
            },
          ],
        },
      },
    ],
  };
}

async function collect(res: Response): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const ev of consumeOpenAiStream(res, undefined)) {
    events.push(ev);
  }
  return events;
}

type ToolCallEvent = Extract<LLMEvent, { type: 'tool-call' }>;
type FinishEvent = Extract<LLMEvent, { type: 'finish' }>;
type ToolStartEvent = Extract<LLMEvent, { type: 'tool-call-start' }>;

describe('consumeOpenAiStream（loop 加固）', () => {
  it('OpenAI 标准顺序：finish_reason 帧之后独立 usage 尾帧被捕获（token 统计不失真根因）', async () => {
    const res = sseResponse([
      { choices: [{ index: 0, delta: { content: '你好' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 34, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 10 } } },
    ]);
    const events = await collect(res);
    const finishes = events.filter((e): e is FinishEvent => e.type === 'finish');
    // 尾帧合并发射：仅一条 finish，且携带真实 usage（不再静默丢弃）
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.finishReason).toBe('stop');
    expect(finishes[0]!.usage?.inputTokens).toBe(1200);
    expect(finishes[0]!.usage?.outputTokens).toBe(34);
    expect(finishes[0]!.usage?.cacheReadTokens).toBe(1000);
  });

  it('finish 帧自带 usage 立即返回（无宽限期等待）', async () => {
    const res = sseResponse([
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
    ]);
    const started = Date.now();
    const events = await collect(res);
    const finish = events.filter((e): e is FinishEvent => e.type === 'finish')[0]!;
    expect(finish.usage!.inputTokens).toBe(7);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('全程无 usage：仅一条 finish 且 usage 为 undefined（调用方走字符估算兜底）', async () => {
    const res = sseResponse([
      { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] },
    ]);
    const events = await collect(res);
    const finishes = events.filter((e): e is FinishEvent => e.type === 'finish');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.usage).toBeUndefined();
  });

  it('finish_reason=stop 仍 flush 已聚合的工具调用（部分平台 stop 携带 tool_calls）', async () => {
    const res = sseResponse([
      toolDelta(0, { id: 'call-1', name: 'bash', args: '{"command":' }),
      toolDelta(0, { args: '"ls"}' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    const events = await collect(res);
    const call = events.find((e): e is ToolCallEvent => e.type === 'tool-call');
    expect(call).toBeDefined();
    expect(call!.tool).toBe('bash');
    expect(call!.input).toEqual({ command: 'ls' });
    const finish = events.find((e): e is FinishEvent => e.type === 'finish');
    expect(finish!.finishReason).toBe('stop');
  });

  it('工具名规范化：剥 functions. 前缀与 :N 后缀', async () => {
    expect(normalizeToolName(' functions.bash:0 ')).toBe('bash');
    expect(normalizeToolName('functions.write:1')).toBe('write');
    expect(normalizeToolName('bash')).toBe('bash');
    const res = sseResponse([
      toolDelta(0, { id: 'call-1', name: 'functions.read:0', args: '{"file":"a.ts"}' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events = await collect(res);
    const call = events.find((e): e is ToolCallEvent => e.type === 'tool-call');
    expect(call!.tool).toBe('read');
  });

  it('参数非合法 JSON → 产出带 parseError 的 tool-call（input=原始串），不再降级为文本', async () => {
    const res = sseResponse([
      toolDelta(0, { id: 'call-1', name: 'bash', args: '{"command": "ls",}' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events = await collect(res);
    expect(events.some((e) => e.type === 'text-delta')).toBe(false);
    const call = events.find((e): e is ToolCallEvent => e.type === 'tool-call');
    expect(call!.input).toBe('{"command": "ls",}');
    expect(call!.parseError).toBeTruthy();
  });

  it('空工具名 → 带 parseError 的 tool-call（错误回传模型而非静默丢弃）', async () => {
    const res = sseResponse([
      toolDelta(0, { id: 'call-1', args: '{"x":1}' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events = await collect(res);
    const call = events.find((e): e is ToolCallEvent => e.type === 'tool-call');
    expect(call!.tool).toBe('');
    expect(call!.parseError).toBeTruthy();
  });

  it('纯 usage 终帧（无 choices/finish_reason）同样 flush 工具调用', async () => {
    const res = sseResponse([
      toolDelta(0, { id: 'call-1', name: 'bash', args: '{"command":"ls"}' }),
      { choices: [] as unknown[], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
    const events = await collect(res);
    const call = events.find((e): e is ToolCallEvent => e.type === 'tool-call');
    expect(call).toBeDefined();
    expect(call!.tool).toBe('bash');
  });

  it('id 先到、name 后到：start 宣告延迟到 name 已知（避免空名残缺卡）', async () => {
    const res = sseResponse([
      toolDelta(0, { id: 'call-1', args: '{"a"' }),
      toolDelta(0, { name: 'read', args: ':1}' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events = await collect(res);
    const start = events.find((e): e is ToolStartEvent => e.type === 'tool-call-start');
    expect(start).toBeDefined();
    expect(start!.tool).toBe('read');
  });
});

describe('估算辅助', () => {
  it('estimateToolsTokens：工具 schema 数组计入窗口估算', () => {
    expect(estimateToolsTokens(undefined)).toBe(0);
    expect(estimateToolsTokens([])).toBe(0);
    const tools = [{ type: 'function', function: { name: 'bash', parameters: { command: { type: 'string' } } } }];
    expect(estimateToolsTokens(tools)).toBeGreaterThan(0);
  });

  it('truncateToolOutput：capOverride 强制覆盖常规/豁免上限', () => {
    const text = 'x'.repeat(3_000);
    expect(truncateToolOutput(text, 'bash', 2_000).length).toBe(2_000 + TOOL_RESULT_TRUNCATE_MARKER.length);
    expect(truncateToolOutput(text, 'skill', 2_000).length).toBe(2_000 + TOOL_RESULT_TRUNCATE_MARKER.length);
    // 无 override 时 skill 仍走豁免上限
    expect(truncateToolOutput(text, 'skill')).toBe(text);
  });
});
