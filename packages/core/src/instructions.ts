import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * 工作区项目指令加载（AGENTS.md，P1-②）：system prompt 的 instructions 槽位。
 * 实例级缓存（mtime+size），文件变更自动失效；缺失/空文件返回空串。
 */

/** 注入内容上限（超长截断，防止挤占上下文） */
const MAX_CHARS = 10_000;

export interface InstructionsCacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

/** 读取 <cwd>/AGENTS.md，带缓存。返回空串表示无指令（调用方跳过注入段） */
export async function loadProjectInstructions(
  cwd: string,
  cache?: Map<string, InstructionsCacheEntry>,
): Promise<string> {
  const file = join(cwd, 'AGENTS.md');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return '';
    const cached = cache?.get(cwd);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.content;
    const raw = await fs.readFile(file, 'utf8');
    const content = raw.trim();
    if (!content) {
      cache?.set(cwd, { mtimeMs: stat.mtimeMs, size: stat.size, content: '' });
      return '';
    }
    const clipped = content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) + '\n…（AGENTS.md 过长，已截断）' : content;
    cache?.set(cwd, { mtimeMs: stat.mtimeMs, size: stat.size, content: clipped });
    return clipped;
  } catch {
    return '';
  }
}

/** 渲染注入段：空指令返回空串（不产生空标签） */
export function renderProjectInstructions(content: string): string {
  const text = content.trim();
  if (!text) return '';
  return `\n\n<project_instructions>\n以下是工作区 AGENTS.md 中用户为本项目定义的指令，优先级高于一般行为约定：\n${text}\n</project_instructions>`;
}
