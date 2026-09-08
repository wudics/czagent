import type { TodoItem } from '../provider.js';
import type { ToolDef, ToolContext } from './types.js';

export type TodoStatus = TodoItem['status'];

export interface TodoInput {
  /** 宽容类型：约定为 string[]，但模型可能传对象（extractTodoText 兜底提取/跳过），运行时不信任 */
  todos?: (string | Record<string, unknown>)[];
  statuses?: Record<string, TodoStatus>;
}

const MAX_ITEMS = 30;

/** 写操作结果尾部提示（持续把模型拉回正确用法） */
export const TODO_HINT = '提示：更新状态只传 statuses（如 {"statuses":{"1":"completed"}}），勿重发整份 todos；已 completed 的项勿重做。';

/** 宽容提取清单文本：字符串直接用；对象依次尝试 text/content/title/task 字段；失败返回 null（勿静默 String() 强转成 "[object Object]"） */
export function extractTodoText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['text', 'content', 'title', 'task']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/** 纯逻辑：在现有清单上应用"写(按文本保留状态)+标状态"，返回新清单 */
export function applyTodo(current: TodoItem[], input: TodoInput): TodoItem[] {
  let next: TodoItem[];
  if (input.todos) {
    const prevStatus = new Map(current.map((t) => [t.text, t.status]));
    const seen = new Set<string>();
    const items: TodoItem[] = [];
    for (const raw of input.todos) {
      const text = extractTodoText(raw);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push({ text, status: prevStatus.get(text) ?? 'pending' });
    }
    next = items.slice(0, MAX_ITEMS);
  } else {
    next = current.map((t) => ({ ...t }));
  }
  if (input.statuses) {
    for (const [key, status] of Object.entries(input.statuses)) {
      const idx = Number(key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < next.length && (status === 'pending' || status === 'in_progress' || status === 'completed')) {
        next[idx] = { ...next[idx]!, status };
      }
    }
  }
  return next;
}

/** 渲染清单文本（供模型读取） */
export function todoToText(items: TodoItem[]): string {
  if (items.length === 0) return '（空）任务清单未建立。';
  return items.map((t, i) => `${i + 1}. [${t.status}] ${t.text}`).join('\n');
}

/** todo 工具：建清单 / 标状态（1 基下标）/ 读取；重发 todos 时同文本项自动保留状态 */
export const todoTool: ToolDef = {
  id: 'todo',
  description:
    '管理会话任务清单（多步任务的结构化跟踪）。开始时传 todos 建立清单一次；之后推进进度只传 statuses（1 基下标，如 {"statuses":{"2":"in_progress","1":"completed"}}），不要重发 todos；仅当清单内容真的变化时才重发 todos（同文本项会自动保留原状态）。无变化不要再调用；已 completed 的项视为做完，勿重做。空参数=读取当前清单。',
  inputSchema: {
    type: 'object',
    properties: {
      todos: { type: 'array', items: { type: 'string' }, description: '字符串数组，如 ["任务1","任务2"]（也接受 {text:"..."} 对象）；仅清单内容变化时重发（同文本项自动保留状态）；建清单时传一次' },
      statuses: {
        type: 'object',
        additionalProperties: { enum: ['pending', 'in_progress', 'completed'] },
        description: '按 1 基下标标注状态，如 {"1":"completed","2":"in_progress"}；更新状态时只传本字段，不带 todos',
      },
    },
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    let todos: string[] | undefined;
    if (Array.isArray(input.todos)) {
      todos = [];
      const bad: unknown[] = [];
      for (const x of input.todos) {
        const text = extractTodoText(x);
        if (text === null) bad.push(x);
        else todos.push(text);
      }
      if (bad.length > 0) {
        throw new Error(
          `todos 格式错误：每项必须是字符串或 {text:"..."} 对象，无法解析 ${bad.length} 项（如 ${JSON.stringify(bad[0])?.slice(0, 120)}）。请改用 {"todos":["任务1","任务2"]} 重试。`,
        );
      }
    }
    const statuses: Record<string, TodoStatus> | undefined = input.statuses && typeof input.statuses === 'object' ? (input.statuses as Record<string, TodoStatus>) : undefined;
    if (!ctx.todo) return todoToText([]);
    return ctx.todo({ ...(todos ? { todos } : {}), ...(statuses ? { statuses } : {}) });
  },
};
