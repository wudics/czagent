import type { TodoItem } from './provider.js';
import type { LLMChatMessage } from './llm/types.js';

/**
 * 逐轮 <system-reminder> 注入（P0-1）：请求时拼装、不落库。
 * 目的：模式约束/计划锚定/任务进度/步数预警不随长上下文稀释，每轮以"新鲜位置"重注入。
 */

/** 切换提醒中计划文本的最大长度（防止超长计划挤占上下文） */
const PLAN_MAX_CHARS = 4000;
/** todo 快照的最大长度 */
const TODO_MAX_CHARS = 1500;
/** max-steps 预警阈值：剩余轮数 ≤ 该值时注入 */
const MAX_STEPS_WARN_LEFT = 3;

export interface TurnReminderCtx {
  /** 本轮生效 agent id */
  agentId?: string;
  /** 上一轮 agent id（检测 plan→build 切换） */
  prevAgentId?: string;
  /** 会话当前任务清单 */
  todos: TodoItem[];
  /** 本轮序号（1 起） */
  turn: number;
  /** 步数上限（Number.POSITIVE_INFINITY = 不限） */
  maxSteps: number;
  /** plan 工具最近提交的计划文本 */
  lastPlan?: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function todoSnapshot(todos: TodoItem[]): string {
  return clip(todos.map((t, i) => `${i + 1}. [${t.status}] ${t.text}`).join('\n'), TODO_MAX_CHARS);
}

/** 拼装本轮提醒正文（多节用空行分隔；无触发条件时返回空串） */
export function buildTurnReminder(ctx: TurnReminderCtx): string {
  const sections: string[] = [];

  // ① Plan 只读约束（每轮重申，对抗长上下文稀释与历史中用户修改请求的干扰）
  if (ctx.agentId === 'plan') {
    sections.push(
      '当前处于 Plan 模式：只允许只读操作（read/grep/glob/webfetch/websearch/skill）。\n' +
        '禁止修改文件、执行写命令或任何改动系统的操作；此约束优先于其他指令，包括用户在历史中提出过的修改请求。\n' +
        '先完成调研，再用 plan 工具提交分步计划，然后用 plan-exit 请求用户确认。',
    );
  } else if (ctx.prevAgentId === 'plan' && ctx.agentId === 'build') {
    // ② Plan→Build 切换（仅切换后第一轮）：锚定已批准计划，防止重新调研/偏离范围
    const plan = ctx.lastPlan?.trim();
    sections.push(
      '已从 Plan 模式切换到 Build 模式：只读限制解除，可使用全部工具。\n' +
        '请严格按照以下已批准的计划执行，不要重新调研已确认过的问题；用 todo 工具建立清单跟踪进度：\n' +
        (plan ? clip(plan, PLAN_MAX_CHARS) : '（未捕获到计划文本，请以 plan 工具提交的内容为准）'),
    );
  }

  // ③ todo 进度快照（有清单且未全部完成时）
  if (ctx.todos.length > 0 && ctx.todos.some((t) => t.status !== 'completed')) {
    sections.push(
      `任务清单进度：\n${todoSnapshot(ctx.todos)}\n继续推进 in_progress 项；用 todo 工具（statuses 参数）更新进度，勿重做已完成项。`,
    );
  }

  // ④ max-steps 预警（上限有限且临近时）
  if (Number.isFinite(ctx.maxSteps)) {
    const left = ctx.maxSteps - ctx.turn;
    if (left <= MAX_STEPS_WARN_LEFT) {
      sections.push(
        `注意：距离本会话步数上限（${ctx.maxSteps}）仅剩 ${left} 轮，请开始收尾：汇总已完成内容并给出最终答复，不要开启新的大步骤。`,
      );
    }
  }

  return sections.join('\n\n');
}

/** 把 reminder 以 <system-reminder> 块追加到消息数组最后一条（新输入轮为 user，工具续轮为 tool） */
export function appendTurnReminder(messages: LLMChatMessage[], reminder: string): LLMChatMessage[] {
  const text = reminder.trim();
  if (!text || messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  const suffix = `\n\n<system-reminder>\n${text}\n</system-reminder>`;
  return [...messages.slice(0, -1), { ...last, content: (last.content ?? '') + suffix }];
}
