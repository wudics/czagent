import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDef, ToolContext } from './types.js';
import { resolveToolPath } from './read.js';

export const writeTool: ToolDef = {
  id: 'write',
  description:
    '创建新文件或整体覆写文件（UTF-8），自动创建父目录。路径相对会话工作目录或绝对路径。\n用法：新文件用本工具；修改已有文件优先用 edit（避免整文件覆盖造成意外丢失），确需重写全部内容时才用 write。\n注意：content 必须是完整文件内容（而非追加/片段）；遵循会话工作目录权限边界。',
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
