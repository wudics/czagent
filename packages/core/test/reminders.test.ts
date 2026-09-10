/** reminders 测试：四类提醒触发条件、拼装位置（最后一条消息）、截断与一次性切换。 */
import { describe, expect, it } from 'vitest';
import { appendTurnReminder, buildTurnReminder } from '../src/reminders.js';
import type { TodoItem } from '../src/provider.js';
import type { LLMChatMessage } from '../src/llm/types.js';

const todo = (text: string, status: TodoItem['status']): TodoItem => ({ text, status });

describe('buildTurnReminder', () => {
  it('build 模式无 todo 且步数不限 → 空串', () => {
    expect(buildTurnReminder({ agentId: 'build', prevAgentId: 'build', todos: [], turn: 1, maxSteps: Number.POSITIVE_INFINITY })).toBe('');
  });

  it('plan 模式：注入只读提醒', () => {
    const r = buildTurnReminder({ agentId: 'plan', prevAgentId: 'plan', todos: [], turn: 3, maxSteps: Number.POSITIVE_INFINITY });
    expect(r).toContain('Plan 模式');
    expect(r).toContain('只读');
    expect(r).toContain('plan-exit');
  });

  it('plan→build 切换：注入切换提醒并携带计划文本；第二轮不再注入', () => {
    const ctx = { prevAgentId: 'plan', todos: [], maxSteps: Number.POSITIVE_INFINITY, lastPlan: '第一步：xxx' };
    const first = buildTurnReminder({ ...ctx, agentId: 'build', turn: 5 });
    expect(first).toContain('已从 Plan 模式切换到 Build 模式');
    expect(first).toContain('第一步：xxx');
    const second = buildTurnReminder({ ...ctx, agentId: 'build', prevAgentId: 'build', turn: 6 });
    expect(second).not.toContain('已从 Plan 模式切换到 Build 模式');
  });

  it('切换但无计划文本 → 提示以 plan 工具提交内容为准', () => {
    const r = buildTurnReminder({ agentId: 'build', prevAgentId: 'plan', todos: [], turn: 5, maxSteps: Number.POSITIVE_INFINITY });
    expect(r).toContain('未捕获到计划文本');
  });

  it('超长计划文本被截断', () => {
    const r = buildTurnReminder({
      agentId: 'build',
      prevAgentId: 'plan',
      todos: [],
      turn: 1,
      maxSteps: Number.POSITIVE_INFINITY,
      lastPlan: '长'.repeat(5000),
    });
    expect(r.length).toBeLessThan(4600);
    expect(r).toContain('…');
  });

  it('有未完成 todo → 注入快照；全部 completed → 不注入', () => {
    const withPending = buildTurnReminder({
      agentId: 'build',
      prevAgentId: 'build',
      todos: [todo('调研', 'completed'), todo('实现', 'in_progress')],
      turn: 2,
      maxSteps: Number.POSITIVE_INFINITY,
    });
    expect(withPending).toContain('任务清单进度');
    expect(withPending).toContain('[in_progress] 实现');
    const allDone = buildTurnReminder({
      agentId: 'build',
      prevAgentId: 'build',
      todos: [todo('调研', 'completed')],
      turn: 2,
      maxSteps: Number.POSITIVE_INFINITY,
    });
    expect(allDone).toBe('');
  });

  it('临近步数上限 → 预警；远离上限或无限步数 → 无预警', () => {
    const near = buildTurnReminder({ agentId: 'build', prevAgentId: 'build', todos: [], turn: 8, maxSteps: 10 });
    expect(near).toContain('仅剩 2 轮');
    const far = buildTurnReminder({ agentId: 'build', prevAgentId: 'build', todos: [], turn: 2, maxSteps: 10 });
    expect(far).toBe('');
    const unlimited = buildTurnReminder({ agentId: 'build', prevAgentId: 'build', todos: [], turn: 999, maxSteps: Number.POSITIVE_INFINITY });
    expect(unlimited).toBe('');
  });

  it('多条件叠加：plan + todo 快照拼在一起', () => {
    const r = buildTurnReminder({
      agentId: 'plan',
      prevAgentId: 'plan',
      todos: [todo('旧任务', 'pending')],
      turn: 1,
      maxSteps: 10,
    });
    expect(r).toContain('Plan 模式');
    expect(r).toContain('任务清单进度');
  });
});

describe('appendTurnReminder', () => {
  it('追加到最后一条消息（user）并保留原有内容', () => {
    const msgs: LLMChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
    ];
    const out = appendTurnReminder(msgs, '提醒内容');
    expect(out).toHaveLength(2);
    expect(out[1]!.content).toBe('你好\n\n<system-reminder>\n提醒内容\n</system-reminder>');
    expect(out[0]!.content).toBe('sys');
  });

  it('工具续轮：追加到最后一条 tool 消息', () => {
    const msgs: LLMChatMessage[] = [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'tool', content: '文件内容', toolCallId: 'c1' },
    ];
    const out = appendTurnReminder(msgs, '提醒');
    expect(out[2]!.role).toBe('tool');
    expect(out[2]!.content).toContain('<system-reminder>');
    expect(out[0]!.content).toBe('问题');
  });

  it('空提醒返回原数组', () => {
    const msgs: LLMChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(appendTurnReminder(msgs, '')).toBe(msgs);
    expect(appendTurnReminder(msgs, '   ')).toBe(msgs);
  });

  it('空消息数组不报错', () => {
    expect(appendTurnReminder([], 'x')).toHaveLength(0);
  });

  it('不修改入参（返回新数组）', () => {
    const msgs: LLMChatMessage[] = [{ role: 'user', content: 'hi' }];
    appendTurnReminder(msgs, '提醒');
    expect(msgs[0]!.content).toBe('hi');
  });
});
