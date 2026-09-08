import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDef, ToolContext } from './types.js';
import { resolveToolPath } from './read.js';

interface Hunk {
  /** 解析自 @@ -a,b +c,d @@：oldStart / oldCount / newStart / newCount */
  oldStart?: number;
  oldCount?: number;
  newStart?: number;
  newCount?: number;
  lines: string[];
}

interface FileOp {
  path: string;
  action: 'update' | 'add' | 'delete';
  hunks: Hunk[];
  addContent?: string;
}

const BEGIN_RE = /^\*\*\* Begin Patch/;
const END_RE = /^\*\*\* End Patch/;
const ADD_RE = /^\*\*\* Add File:\s*(.+)$/;
const DELETE_RE = /^\*\*\* Delete File:\s*(.+)$/;
const UPDATE_RE = /^\*\*\* Update File:\s*(.+)$/;
const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parsePatch(patch: string): FileOp[] {
  const ops: FileOp[] = [];
  const lines = patch.split('\n');
  let current: FileOp | null = null;
  let inHunk = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (BEGIN_RE.test(line)) continue;
    if (END_RE.test(line)) {
      current = null;
      inHunk = false;
      continue;
    }
    const addM = line.match(ADD_RE);
    if (addM) {
      current = { path: addM[1]!.trim(), action: 'add', hunks: [] };
      ops.push(current);
      inHunk = false;
      continue;
    }
    const delM = line.match(DELETE_RE);
    if (delM) {
      current = { path: delM[1]!.trim(), action: 'delete', hunks: [] };
      ops.push(current);
      inHunk = false;
      continue;
    }
    const updM = line.match(UPDATE_RE);
    if (updM) {
      current = { path: updM[1]!.trim(), action: 'update', hunks: [] };
      ops.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (current.action === 'add') {
      current.addContent = (current.addContent ?? '') + line + '\n';
      continue;
    }
    if (current.action === 'update') {
      const hunkM = line.match(HUNK_RE);
      if (hunkM) {
        inHunk = true;
        current.hunks.push({
          lines: [],
          oldStart: Number(hunkM[1]),
          oldCount: hunkM[2] ? Number(hunkM[2]) : 0,
          newStart: Number(hunkM[3]),
          newCount: hunkM[4] ? Number(hunkM[4]) : 0,
        });
        continue;
      }
      if (inHunk) {
        const last = current.hunks[current.hunks.length - 1]!;
        if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
          last.lines.push(line);
        } else {
          inHunk = false;
        }
      }
    }
  }
  return ops;
}

function findOccurrences(lines: string[], search: string[]): number[] {
  const out: number[] = [];
  if (search.length === 0) return out;
  outer: for (let i = 0; i <= lines.length - search.length; i++) {
    for (let j = 0; j < search.length; j++) {
      if (lines[i + j] !== search[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

function matchesAt(lines: string[], idx: number, search: string[]): boolean {
  if (idx < 0 || idx + search.length > lines.length) return false;
  for (let j = 0; j < search.length; j++) {
    if (lines[idx + j] !== search[j]) return false;
  }
  return true;
}

function applyHunk(lines: string[], hunk: Hunk): { lines: string[]; changed: number } {
  const search = hunk.lines.filter((l) => l[0] !== '+').map((l) => l.slice(1));
  const result = hunk.lines.filter((l) => l[0] !== '-').map((l) => l.slice(1));

  // 纯插入（无上下文/删除行）：按 @@ 行号锚点插入
  if (search.length === 0) {
    const anchor = Math.max(0, Math.min((hunk.oldStart ?? 1) - 1, lines.length));
    return {
      lines: [...lines.slice(0, anchor), ...result, ...lines.slice(anchor)],
      changed: result.length,
    };
  }

  const occurrences = findOccurrences(lines, search);
  if (occurrences.length === 0) throw new Error('hunk 上下文无法在文件中匹配');

  let idx = -1;
  // 1) @@ 行号锚点优先：命中模型意图的位置
  if (hunk.oldStart !== undefined && matchesAt(lines, hunk.oldStart - 1, search)) {
    idx = hunk.oldStart - 1;
  }
  // 2) 唯一匹配兜底（容忍行号漂移）
  if (idx < 0 && occurrences.length === 1) idx = occurrences[0]!;
  // 3) 多处匹配且锚点未命中 → 显式报错，避免改错位置
  if (idx < 0) {
    throw new Error('匹配位置不唯一，请提供更完整的上下文（含 @@ 行号），以便唯一定位');
  }

  return {
    lines: [...lines.slice(0, idx), ...result, ...lines.slice(idx + search.length)],
    changed: result.length - search.length,
  };
}

/** 提取补丁涉及的文件路径（供权限判定） */
export function patchFilePaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    const m =
      line.match(UPDATE_RE) ?? line.match(ADD_RE) ?? line.match(DELETE_RE);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

export const patchTool: ToolDef = {
  id: 'patch',
  description:
    '用 apply_patch 格式批量修改多个文件：以 *** Begin Patch 开头，*** Update File: <path> 后跟 @@ hunk（空格=上下文，- 删除，+ 新增），支持 *** Add File / *** Delete File，以 *** End Patch 结尾。',
  inputSchema: {
    type: 'object',
    properties: { patch: { type: 'string', description: 'apply_patch 格式的补丁文本' } },
    required: ['patch'],
  },
  async execute(input, ctx: ToolContext) {
    const patch = String(input.patch ?? '');
    if (!patch.trim()) throw new Error('缺少 patch 参数');

    const ops = parsePatch(patch);
    if (ops.length === 0) throw new Error('未解析到任何文件操作（需以 *** Begin Patch 开头）');

    const summary: string[] = [];
    for (const op of ops) {
      const target = resolveToolPath(ctx.cwd, op.path);
      if (op.action === 'delete') {
        await fs.rm(target, { force: true });
        summary.push(`删除 ${target}`);
        continue;
      }
      if (op.action === 'add') {
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, op.addContent ?? '', 'utf8');
        summary.push(`新增 ${target}`);
        continue;
      }
      const text = await fs.readFile(target, 'utf8');
      let lines = text.split('\n');
      let totalChanged = 0;
      // 按 oldStart 降序应用（先改下面的 hunk，保证上面 hunk 的行号锚点仍准确）
      const hunks = [...op.hunks].sort((a, b) => (b.oldStart ?? Infinity) - (a.oldStart ?? Infinity));
      for (const hunk of hunks) {
        const r = applyHunk(lines, hunk);
        lines = r.lines;
        totalChanged += r.changed;
      }
      await fs.writeFile(target, lines.join('\n'), 'utf8');
      summary.push(`更新 ${target}（净变更 ${totalChanged} 行）`);
    }
    return summary.join('\n');
  },
};
