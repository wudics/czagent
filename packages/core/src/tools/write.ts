import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDef, ToolContext } from './types.js';
import { resolveToolPath } from './read.js';

export const writeTool: ToolDef = {
  id: 'write',
  description: '创建或整文件写入（UTF-8）。参数 file 相对当前工作目录或绝对路径；会自动创建父目录。',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['file', 'content'],
  },
  async execute(input, ctx: ToolContext) {
    const file = String(input.file ?? '');
    const content = String(input.content ?? '');
    if (!file) throw new Error('缺少 file 参数');

    const target = resolveToolPath(ctx.cwd, file);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');

    const lines = content.length === 0 ? 0 : content.split('\n').length;
    return `已写入 ${target}\n行数: ${lines}，字节: ${Buffer.byteLength(content, 'utf8')}`;
  },
};
