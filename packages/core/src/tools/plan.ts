import type { ToolDef, ToolContext } from './types.js';

export const planTool: ToolDef = {
  id: 'plan',
  description: '提交实施计划（Plan 模式）：把调研结论整理为清晰的分步计划；提交后可调用 plan-exit 请求用户确认执行',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: '完整的分步实施计划（Markdown）' },
    },
    required: ['plan'],
  },
  async execute(input) {
    const plan = String(input.plan ?? '').trim();
    if (!plan) throw new Error('缺少 plan 参数');
    return `计划已提交（共 ${plan.length} 字）。如需开始执行，请调用 plan-exit 工具请求用户确认切换到 Build 模式。`;
  },
};

export const planExitTool: ToolDef = {
  id: 'plan-exit',
  description: '请求结束 Plan 模式并切换到 Build 模式执行计划（需用户在会话中确认）',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_input, ctx: ToolContext) {
    const decision = await ctx.ask({ tool: 'plan-exit', args: {} });
    if (decision === 'deny') {
      return '用户暂不切换到执行模式。请继续完善计划或向用户说明等待确认。';
    }
    if (ctx.setAgent) await ctx.setAgent('build');
    return '用户已确认，当前会话已切换到 Build 模式。请按计划开始执行。';
  },
};
