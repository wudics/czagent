import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import type { ToolDef, ToolContext } from './types.js';
import { resolveToolPath } from './read.js';

const MAX_FILES = 200;
const MAX_MATCHES = 60;
const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/dist/**', '**/out/**'];

function toRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

export const grepTool: ToolDef = {
  id: 'grep',
  description:
    '在工作目录中按正则或关键字搜索文件内容，返回 file:line:content 匹配行（上限 60 条）。找函数/类定义、配置项、调用点等用它；只知道文件名用 glob。\n用法：结果过多时用 include 收窄文件类型（如 *.ts）或用 path 限定目录；pattern 写正则，非法时自动按字面匹配。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则；若非法则按字面匹配）' },
      include: { type: 'string', description: '文件 glob（如 *.ts 或 **/*.md），默认所有文件' },
      path: { type: 'string', description: '搜索目录，默认工作目录' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx: ToolContext) {
    const pattern = String(input.pattern ?? '');
    const include = String(input.include ?? '**/*');
    const searchDir = resolveToolPath(ctx.cwd, String(input.path ?? '.'));
    if (!pattern) throw new Error('缺少 pattern 参数');

    const re = toRegExp(pattern);
    const files = await fg(include, {
      cwd: searchDir,
      onlyFiles: true,
      dot: false,
      ignore: DEFAULT_IGNORE,
      suppressErrors: true,
      absolute: true,
    });

    const results: string[] = [];
    let scanned = 0;
    for (const file of files.slice(0, MAX_FILES)) {
      if (ctx.signal.aborted) break;
      scanned++;
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (re.test(line)) {
          results.push(`${file}:${i + 1}: ${line.slice(0, 200)}`);
          if (results.length >= MAX_MATCHES) break;
        }
      }
      if (results.length >= MAX_MATCHES) break;
    }

    if (results.length === 0) {
      return `未找到匹配（扫描 ${scanned} 个文件，模式 /${pattern}/）`;
    }
    const more = results.length >= MAX_MATCHES ? '\n…（结果已截断）' : '';
    return results.join('\n') + more;
  },
};
