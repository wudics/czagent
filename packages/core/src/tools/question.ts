import type { ToolDef, ToolContext } from './types.js';

/**
 * 向用户提问（B）：暂停当前轮 → 会话浮层弹问题（可选项 + 自由输入）→ 回答以 tool-result 返回模型。
 * 仅在确实需要用户澄清/选择时使用。
 */
export const questionTool: ToolDef = {
  id: 'question',
  description:
    '向用户提出一个问题以澄清需求或让用户选择（可给预设选项，用户也能自由输入）。调用后会暂停等待用户回答，回答文本将作为结果返回。仅在任务信息不足、确实需要用户输入时使用，勿滥用。',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题（清晰、具体）' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：给用户可一键点选的预设选项；缺省用户自由输入',
      },
    },
    required: ['question'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const question = String(input.question ?? '').trim();
    if (!question) throw new Error('question 工具缺少 question 参数');
    const options = Array.isArray(input.options) ? input.options.map((x) => String(x)).filter(Boolean) : undefined;
    if (!ctx.askUser) return '';
    const answer = await ctx.askUser({ question, ...(options && options.length > 0 ? { options } : {}) });
    return answer.trim() || '<用户未回答>';
  },
};
