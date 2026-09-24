/** compaction 截断测试：常规阈值、skill 豁免（宽松上限）、截断标记。 */
import { describe, expect, it } from 'vitest';
import {
  FULL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATE_CHARS,
  TOOL_RESULT_TRUNCATE_MARKER,
  truncateToolOutput,
} from '../src/compaction.js';

describe('truncateToolOutput', () => {
  it('常规工具超阈值截断并加标记', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS + 100);
    const out = truncateToolOutput(text, 'bash');
    expect(out.length).toBe(TOOL_RESULT_TRUNCATE_CHARS + TOOL_RESULT_TRUNCATE_MARKER.length);
    expect(out.endsWith(TOOL_RESULT_TRUNCATE_MARKER)).toBe(true);
  });

  it('常规工具阈值内不截断', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS);
    expect(truncateToolOutput(text, 'bash')).toBe(text);
  });

  it('skill 豁免常规阈值（10k~32k 之间不截断）', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS + 1);
    expect(truncateToolOutput(text, 'skill')).toBe(text);
    expect(truncateToolOutput(text)).toBe(text.slice(0, TOOL_RESULT_TRUNCATE_CHARS) + TOOL_RESULT_TRUNCATE_MARKER);
  });

  it('skill 超宽松安全上限仍截断', () => {
    const text = 'x'.repeat(FULL_RESULT_MAX_CHARS + 1);
    const out = truncateToolOutput(text, 'skill');
    expect(out.length).toBe(FULL_RESULT_MAX_CHARS + TOOL_RESULT_TRUNCATE_MARKER.length);
    expect(out.endsWith(TOOL_RESULT_TRUNCATE_MARKER)).toBe(true);
  });

  it('未指定工具名按常规阈值（回归）', () => {
    const text = 'x'.repeat(TOOL_RESULT_TRUNCATE_CHARS + 1);
    expect(truncateToolOutput(text)).toBe(text.slice(0, TOOL_RESULT_TRUNCATE_CHARS) + TOOL_RESULT_TRUNCATE_MARKER);
  });
});

/** usage 折算与统一上下文占用估算（修"面板 33% 就触发压缩"两个口径脱节的回归锚定） */
import type { ChatMessage, Usage } from '../src/provider.js';
import { estimateContextUsed, estimateMessageTokens, usageTotal } from '../src/compaction.js';

function usage(i: number, o: number, extra?: Partial<Usage>): Usage {
  return { inputTokens: i, outputTokens: o, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, ...extra };
}

describe('usageTotal', () => {
  it('OpenAI 语义（input 已含 cache、output 已含 reasoning）不再重复累加子集字段', () => {
    // DeepSeek/siliconflow：命中 90% 时旧口径虚高近 2 倍 → 33% 位置误触发压缩的根因之一
    const u = usage(10_000, 500, { reasoningTokens: 300, cacheReadTokens: 9_000 });
    expect(usageTotal(u)).toBe(10_500);
  });
  it('undefined → 0', () => expect(usageTotal(undefined)).toBe(0));
});

describe('estimateContextUsed（锚点 + 增量）', () => {
  const user = (text: string): ChatMessage => ({ id: 'u-' + text, sessionId: 's', role: 'user', parts: [{ type: 'text', text: text + ' ' + '中'.repeat(200) }], createdAt: 1 });
  const asst = (tokens?: Usage): ChatMessage => ({ id: 'a-' + (tokens?.inputTokens ?? 'x'), sessionId: 's', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], tokens, createdAt: 2 });

  it('无锚点：回退 fallback 纯估算', () => {
    expect(estimateContextUsed([user('hello')], 1234)).toBe(1234);
  });

  it('锚点 usageTotal + 其后新消息逐条估算累加', () => {
    const h = [user('q1'), asst(usage(5000, 200)), user('追加的新输入')];
    const v = estimateContextUsed(h, 999_999);
    expect(v).toBe(5200 + estimateMessageTokens(h[2]!));
  });

  it('checkpoint 之后未出现新锚点 → 纯估算 fallback（旧 usageTotal 不会误判仍超限）', () => {
    const checkpoint: ChatMessage = { id: 'c1', sessionId: 's', role: 'user', parts: [{ type: 'compaction', summary: '摘要', coversBefore: 1 }], createdAt: 3 };
    const h = [asst(usage(90_000, 500)), checkpoint, user('压缩后新输入')];
    expect(estimateContextUsed(h, 777)).toBe(777);
  });

  it('checkpoint 之后出现新锚点 → 新锚点生效', () => {
    const checkpoint: ChatMessage = { id: 'c1', sessionId: 's', role: 'user', parts: [{ type: 'compaction', summary: '摘要', coversBefore: 1 }], createdAt: 3 };
    const h = [checkpoint, asst(usage(3000, 100)), user('后续')];
    const v = estimateContextUsed(h, 999_999);
    expect(v).toBeGreaterThanOrEqual(3100);
    expect(v).toBeLessThan(999_999);
  });
});

/** 摘要规则（opencode 同款：模板派生校验集 + hasSummarySection 结构校验） */
import { buildSummaryInstruction, hasSummarySection, SUMMARY_HEADINGS, SUMMARY_REMINDER } from '../src/compaction.js';

describe('hasSummarySection', () => {
  it('精确命中任一模板小节标题即合规', () => {
    expect(hasSummarySection('前言一行\n## 任务目标\n- 做 X')).toBe(true);
    expect(hasSummarySection('## 要求与约束')).toBe(true);
  });
  it('非模板标题/变形写法不命中', () => {
    expect(hasSummarySection('### 任务目标')).toBe(false);
    expect(hasSummarySection('##任务目标')).toBe(false);
  });
  it('纯散文/空文本拒绝（半截或拒答输出不能定稿为摘要）', () => {
    expect(hasSummarySection('这段对话谈论了一些工作，没有小节。')).toBe(false);
    expect(hasSummarySection('')).toBe(false);
  });
});

describe('buildSummaryInstruction（指令与校验集自洽）', () => {
  it('指令包含校验用的全部小节标题（改措辞不会让校验悄悄失配）', () => {
    const ins = buildSummaryInstruction();
    for (const h of SUMMARY_HEADINGS) expect(ins).toContain(h);
    expect(SUMMARY_HEADINGS.length).toBeGreaterThanOrEqual(7);
  });
  it('既有摘要合并：previousSummary 正文内联进指令', () => {
    const ins = buildSummaryInstruction('旧摘要正文XYZ');
    expect(ins).toContain('旧摘要正文XYZ');
    expect(ins).toContain('更近的历史优先');
  });
  it('追问指令独立成句、不要求模型复述历史轮', () => {
    expect(SUMMARY_REMINDER).toContain('不要调用任何工具');
    expect(SUMMARY_REMINDER).toContain('摘要');
  });
});

