import { promises as fs } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { ToolDef, ToolContext } from './types.js';

export function resolveToolPath(cwd: string, p: string): string {
  if (!p) return resolve(cwd);
  if (isAbsolute(p)) return normalize(p);
  return resolve(join(cwd, p));
}

const MAX_READ_BYTES = 2 * 1024 * 1024;

export const readTool: ToolDef = {
  id: 'read',
  description:
    '读取文件内容（UTF-8 文本，单次上限 2MB）。路径相对会话工作目录或绝对路径；offset/limit 控制行范围（默认从头 2000 行）。\n用法：大文件先用小 limit 试探再按需分段；返回头带总行数与当前区间，未读完继续用 offset 接着读。\n注意：二进制/超大文件会报错，改用 grep 定位或 glob 找文件；读取不存在的文件会报错，不确定路径时先用 glob 确认。',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径（相对 cwd 或绝对）' },
      offset: { type: 'number', description: '起始行（从 0 开始），默认 0' },
      limit: { type: 'number', description: '最多读取的行数，默认 2000' },
    },
    required: ['file'],
  },
  async execute(input, ctx: ToolContext) {
    const file = String(input.file ?? '');
    const offset = Number(input.offset ?? 0);
    const limit = Number(input.limit ?? 2000);
    if (!file) throw new Error('缺少 file 参数');

    const target = resolveToolPath(ctx.cwd, file);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`不是文件: ${target}`);
    if (stat.size > MAX_READ_BYTES) throw new Error('文件过大（>2MB），请改用 grep 或分段读取');

    const text = await fs.readFile(target, 'utf8');
    const lines = text.split('\n');
    const slice = lines.slice(offset, offset + limit);
    const total = lines.length;
    const truncated = offset + slice.length < total;
    const head = `// ${target}（共 ${total} 行，当前显示 ${offset + 1}–${offset + slice.length}${truncated ? '，已截断' : ''}）\n`;
    return head + slice.join('\n');
  },
};
