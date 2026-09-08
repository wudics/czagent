import type { ToolDef, ToolContext } from './types.js';

/**
 * task 子代理工具（决策 6 P2）：主会话模型把独立/可并行的子任务派发给指定 Agent，
 * 子代理在隔离上下文中自主多轮执行（工具/权限照常），最终文本作为 tool-result 返回。
 * 子代理内部不再暴露 task/question（防嵌套、保持主会话专用）。
 */
export const taskTool: ToolDef = {
  id: 'task',
  description:
    '把一个自包含的子任务派遣给指定 Agent（默认 build）在隔离上下文中执行，返回其最终结果文本。适合互相独立、可并行的研究/实现类子任务；prompt 必须自包含（子代理看不到当前对话历史）。同一批次互相独立的子任务可以连续多次调用本工具。',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: '目标 Agent id（如 build/plan 或自定义），默认 build' },
      prompt: { type: 'string', description: '自包含的任务描述：目标、输入（文件路径/上下文）、期望输出形式' },
    },
    required: ['prompt'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new Error('缺少 prompt 参数');
    const agentId = (input.agent ? String(input.agent) : 'build').trim();
    const known = ctx.settings.agents.filter((a) => a.id === agentId);
    if (known.length === 0) {
      throw new Error(`未知 Agent「${agentId}」，可用：${ctx.settings.agents.map((a) => a.id).join('、')}`);
    }
    if (!ctx.runAgent) throw new Error('task 仅在主会话中可用');
    const result = await ctx.runAgent(prompt, { agentId });
    return result.trim() || '（子代理没有产出内容）';
  },
};
