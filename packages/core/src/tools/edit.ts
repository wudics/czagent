import { promises as fs } from 'node:fs';
import type { ToolDef, ToolContext } from './types.js';
import { resolveToolPath } from './read.js';

export const editTool: ToolDef = {
  id: 'edit',
  description:
    '对文件做精确字符串替换（小步修改首选）。oldText 必须在文件中唯一出现（含缩进），多匹配/未匹配都会报错。\n用法：编辑前先用 read 确认原文，勿凭记忆写 oldText；匹配不唯一时在 oldText 中带上前后几行上下文使其唯一。\n注意：适合点状修改；大范围重构/新建文件用 write，复杂多处改动可用 patch。',
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
