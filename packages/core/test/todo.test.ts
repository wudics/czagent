/** todo 工具测试：宽容提取（对象字段）、畸形输入兜底报错、同文本状态保留回归。 */
import { describe, expect, it } from 'vitest';
import { applyTodo, extractTodoText, todoTool, type TodoInput } from '../src/tools/todo.js';
import type { ToolContext } from '../src/tools/types.js';

/** 带内存状态的 ctx.todo mock（模拟 SessionManager.updateSessionTodo） */
function makeCtx() {
  let items: ReturnType<typeof applyTodo> = [];
  const ctx = {
    todo: (input: TodoInput) => {
      items = applyTodo(items, input);
      return Promise.resolve(
        items.map((t, i) => `${i + 1}. [${t.status}] ${t.text}`).join('\n') || '（空）任务清单未建立。',
      );
    },
  } as unknown as ToolContext;
  return { ctx, items: () => items };
}

describe('extractTodoText', () => {
  it('字符串直接可用（含 trim）', () => {
    expect(extractTodoText(' 写文档 ')).toBe('写文档');
    expect(extractTodoText('   ')).toBeNull();
  });

  it('对象依次尝试 text/content/title/task 字段', () => {
    expect(extractTodoText({ text: 'A' })).toBe('A');
    expect(extractTodoText({ content: 'B' })).toBe('B');
    expect(extractTodoText({ title: 'C' })).toBe('C');
    expect(extractTodoText({ task: 'D' })).toBe('D');
    expect(extractTodoText({ content: '  B2  ' })).toBe('B2');
  });

  it('无法提取时返回 null 而非 "[object Object]"', () => {
    expect(extractTodoText({ foo: 1 })).toBeNull();
    expect(extractTodoText({ text: { nested: true } })).toBeNull();
    expect(extractTodoText(42)).toBeNull();
    expect(extractTodoText(null)).toBeNull();
  });
});

describe('applyTodo', () => {
  it('对象条目按字段提取写入', () => {
    const next = applyTodo([], { todos: [{ text: 'A' }, 'B', { content: 'C' }] });
    expect(next.map((t) => t.text)).toEqual(['A', 'B', 'C']);
    expect(next.every((t) => t.status === 'pending')).toBe(true);
  });

  it('畸形条目被跳过且不产生 "[object Object]"', () => {
    const next = applyTodo([], { todos: [{ foo: 1 }, '有效'] });
    expect(next.map((t) => t.text)).toEqual(['有效']);
  });

  it('同文本项重发时保留原状态', () => {
    const first = applyTodo([], { todos: ['A', 'B'] });
    const marked = applyTodo(first, { statuses: { '1': 'completed' } });
    expect(marked[0]!.status).toBe('completed');
    const rewritten = applyTodo(marked, { todos: [{ text: 'A' }, 'B', 'C'] });
    expect(rewritten[0]!.status).toBe('completed');
    expect(rewritten[1]!.status).toBe('pending');
    expect(rewritten[2]!.status).toBe('pending');
  });
});

describe('todoTool.execute', () => {
  it('字符串与 {text} 对象混用正常建单', async () => {
    const { ctx, items } = makeCtx();
    await todoTool.execute({ todos: ['A', { text: 'B' }] }, ctx);
    expect(items().map((t) => t.text)).toEqual(['A', 'B']);
  });

  it('畸形条目抛出含用法示例的错误，且不产生 "[object Object]"', async () => {
    const { ctx } = makeCtx();
    await expect(todoTool.execute({ todos: [{ foo: { deep: 1 } }, { bar: 2 }] }, ctx)).rejects.toThrow(
      /todos 格式错误.*\{"foo":\{"deep":1\}\}.*"todos":\["任务1","任务2"\]/s,
    );
  });

  it('statuses 正常标注（回归）', async () => {
    const { ctx, items } = makeCtx();
    await todoTool.execute({ todos: ['A', 'B'] }, ctx);
    await todoTool.execute({ statuses: { '1': 'completed', '2': 'in_progress' } }, ctx);
    expect(items()[0]!.status).toBe('completed');
    expect(items()[1]!.status).toBe('in_progress');
  });
});
