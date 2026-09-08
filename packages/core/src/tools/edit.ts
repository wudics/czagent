import { promises as fs } from 'node:fs';
import type { ToolDef, ToolContext } from './types.js';
import { resolveToolPath } from './read.js';

export const editTool: ToolDef = {
  id: 'edit',
  description: '对文件做精确字符串替换。oldText 必须在文件中唯一出现；多匹配/未匹配都会报错。',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径' },
      oldText: { type: 'string', description: '要被替换的精确文本（唯一）' },
      newText: { type: 'string', description: '替换后的文本' },
    },
    required: ['file', 'oldText', 'newText'],
  },
  async execute(input, ctx: ToolContext) {
    const file = String(input.file ?? '');
    const oldText = String(input.oldText ?? '');
    const newText = String(input.newText ?? '');
    if (!file || !oldText) throw new Error('缺少 file/oldText 参数');

    const target = resolveToolPath(ctx.cwd, file);
    const text = await fs.readFile(target, 'utf8');
    const count = text.split(oldText).length - 1;
    if (count === 0) {
      throw new Error(`未找到要替换的内容（oldText 未出现）: ${oldText.slice(0, 80)}`);
    }
    if (count > 1) {
      throw new Error(`oldText 在文件中出现 ${count} 次，请提供更多上下文以唯一匹配`);
    }

    const next = text.replace(oldText, newText);
    await fs.writeFile(target, next, 'utf8');
    return `已编辑 ${target}\n替换 1 处：\n${oldText.slice(0, 80)}\n→\n${newText.slice(0, 80)}`;
  },
};
