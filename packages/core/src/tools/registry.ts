import type { ToolDef } from './types.js';

/** 内部工具：不随"全部工具"（agentTools 为空）注入，仅显式列出的 agent（plan）持有 */
export const INTERNAL_TOOLS = ['plan', 'plan-exit'];

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.id, tool);
  }

  registerAll(tools: ToolDef[]): void {
    for (const t of tools) this.register(t);
  }

  get(id: string): ToolDef | undefined {
    return this.tools.get(id);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** 按 agent 允许的工具 id 集合 + 禁用集合过滤；集合为空 = 全部（内部工具除外） */
  resolve(agentToolIds: string[], disabled: Set<string>): ToolDef[] {
    return this.list().filter((t) => {
      if (disabled.has(t.id)) return false;
      if (agentToolIds.length === 0) return !INTERNAL_TOOLS.includes(t.id);
      return agentToolIds.includes(t.id);
    });
  }

  /** 全量工具（不含内部），供能力组展开校验使用 */
  publicToolIds(): string[] {
    return this.list()
      .map((t) => t.id)
      .filter((id) => !INTERNAL_TOOLS.includes(id));
  }

  /** 转 OpenAI tools 数组 */
  toOpenAI(tools: ToolDef[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.id, description: t.description, parameters: t.inputSchema },
    }));
  }
}
