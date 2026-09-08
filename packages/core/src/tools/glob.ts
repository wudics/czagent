import fg from 'fast-glob';
import type { ToolDef, ToolContext } from './types.js';
import { resolveToolPath } from './read.js';

const MAX_RESULTS = 200;
const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/dist/**', '**/out/**'];

export const globTool: ToolDef = {
  id: 'glob',
  description: '按 glob 模式列出文件路径（相对于工作目录）。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 src/**/*.ts' },
      path: { type: 'string', description: '搜索目录，默认工作目录' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx: ToolContext) {
    const pattern = String(input.pattern ?? '');
    const base = resolveToolPath(ctx.cwd, String(input.path ?? '.'));
    if (!pattern) throw new Error('缺少 pattern 参数');

    const entries = await fg(pattern, {
      cwd: base,
      onlyFiles: true,
      dot: false,
      ignore: DEFAULT_IGNORE,
      suppressErrors: true,
      absolute: false,
    });

    const list = entries.slice(0, MAX_RESULTS);
    const more = entries.length > MAX_RESULTS ? `\n…（共 ${entries.length} 项，已截断）` : '';
    return list.length === 0 ? '无匹配文件' : list.join('\n') + more;
  },
};
