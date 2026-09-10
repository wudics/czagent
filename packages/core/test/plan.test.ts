/** plan 工具测试：富输出（模型收短文本 + 可见 markdown 全文）、plan-exit 拒绝即抛 UserRejectedError、确认后切 agent。 */
import { describe, expect, it } from 'vitest';
import { planExitTool, planTool } from '../src/tools/plan.js';
import { isRichToolOutput } from '../src/tools/rich-output.js';
import { UserRejectedError, type ToolContext } from '../src/tools/types.js';

function makeCtx(overrides: Partial<ToolContext>): ToolContext {
  return {
    ask: async () => 'allow',
    ...overrides,
  } as unknown as ToolContext;
}

describe('planTool', () => {
  it('返回富输出：模型收短文本，计划全文进 markdown part', async () => {
    const saved: string[] = [];
    const ctx = makeCtx({ savePlan: (p) => saved.push(p) });
    const out = await planTool.execute({ plan: '## 步骤\n1. 改文件\n2. 跑测试' }, ctx);
    expect(isRichToolOutput(out)).toBe(true);
    const rich = out as { text: string; markdown?: { text: string } };
    expect(rich.text).toContain('计划已提交');
    expect(rich.text).toContain('plan-exit');
    expect(rich.markdown?.text).toBe('## 步骤\n1. 改文件\n2. 跑测试');
    expect(saved).toEqual(['## 步骤\n1. 改文件\n2. 跑测试']);
  });

  it('空 plan 报错', async () => {
    await expect(planTool.execute({ plan: '   ' }, makeCtx({}))).rejects.toThrow('缺少 plan 参数');
  });
});

describe('planExitTool', () => {
  it('用户拒绝 → 抛 UserRejectedError（runLoop 识别后终止本轮）且不切 agent', async () => {
    let switched = '';
    const ctx = makeCtx({
      ask: async () => 'deny',
      setAgent: async (id) => {
        switched = id;
      },
      lastPlan: () => '计划全文',
    });
    await expect(planExitTool.execute({}, ctx)).rejects.toBeInstanceOf(UserRejectedError);
    expect(switched).toBe('');
  });

  it('用户确认 → 切换到 build 并返回确认文案', async () => {
    let switched = '';
    const asks: unknown[] = [];
    const ctx = makeCtx({
      ask: async (req) => {
        asks.push(req);
        return 'allow';
      },
      setAgent: async (id) => {
        switched = id;
      },
      lastPlan: () => '计划全文',
    });
    const out = await planExitTool.execute({}, ctx);
    expect(switched).toBe('build');
    expect(out).toContain('Build');
    expect(asks[0]).toMatchObject({ tool: 'plan-exit', args: { plan: '计划全文' } });
  });

  it('无 lastPlan 时 args 不带 plan 字段', async () => {
    const asks: unknown[] = [];
    const ctx = makeCtx({
      ask: async (req) => {
        asks.push(req);
        return 'deny';
      },
    });
    await expect(planExitTool.execute({}, ctx)).rejects.toBeInstanceOf(UserRejectedError);
    expect(asks[0]).toMatchObject({ tool: 'plan-exit', args: {} });
  });
});
