import type { ToolDef, ToolContext } from './types.js';
import { UserRejectedError } from './types.js';
import { richOutput } from './rich-output.js';

export const planTool: ToolDef = {
  id: 'plan',
  description:
    '提交实施计划（Plan 模式专用）：把调研结论整理为清晰的分步计划（Markdown）。计划应完整覆盖实施步骤、涉及文件与验证方式，同时保持简洁。提交后调用 plan-exit 请求用户确认执行。',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: '完整的分步实施计划（Markdown）' },
    },
    required: ['plan'],
  },
  async execute(input, ctx: ToolContext) {
    const plan = String(input.plan ?? '').trim();
    if (!plan) throw new Error('缺少 plan 参数');
    ctx.savePlan?.(plan);
    // 富输出：计划全文追加为可见 markdown part（用户直接可读），模型只收短文本
    return richOutput({
      text: `计划已提交（共 ${plan.length} 字）。如需开始执行，请调用 plan-exit 工具请求用户确认切换到 Build 模式。`,
      markdown: { title: '实施计划', text: plan },
    });
  },
};

export const planExitTool: ToolDef = {
  id: 'plan-exit',
  description:
    '请求结束 Plan 模式并切换到 Build 模式执行计划。会向用户弹出确认（用户拒绝则留在 Plan 模式并停止本轮）；确认通过后按已批准的计划开始执行。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_input, ctx: ToolContext) {
    const plan = ctx.lastPlan?.();
    const decision = await ctx.ask({ tool: 'plan-exit', args: plan ? { plan } : {} });
    if (decision === 'deny') {
      // 抛哨兵错误：runLoop 识别后终止本轮（默认拒绝即停；用户留在 Plan 模式）
      throw new UserRejectedError('用户暂不切换到执行模式，已留在 Plan 模式');
    }
    if (ctx.setAgent) await ctx.setAgent('build');
    return '用户已确认，当前会话已切换到 Build 模式。请按计划开始执行。';
  },
};
