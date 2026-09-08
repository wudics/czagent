/** Skill 技能系统（I8）：三层发现 + opencode 兼容 frontmatter 解析。 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDef } from '../provider.js';

export type SkillSource = 'builtin' | 'global' | 'workspace';

export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** 技能目录 */
  dir: string;
  source: SkillSource;
  /** SKILL.md 正文（frontmatter 之后） */
  body: string;
}

/** 轻量 frontmatter 解析：顶层标量 + 一级嵌套（metadata:）+ 内联数组 + 破折号列表；容错跳过无法识别的行 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  const data: Record<string, unknown> = {};
  const body = m ? raw.slice(m[0].length) : raw;
  if (!m) return { data, body };

  const scalar = (t: string): unknown => {
    const s = t.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      return s
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    return s;
  };

  let current: Record<string, unknown> = data;
  let pendingList: { obj: Record<string, unknown>; key: string; arr: unknown[] } | null = null;

  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (item && pendingList) {
      pendingList.arr.push(scalar(item[1]!));
      continue;
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const rawVal = kv[2]!.trim();
    const indented = /^\s/.test(line);
    if (!indented) current = data;

    if (rawVal === '') {
      if (indented) {
        const arr: unknown[] = [];
        current[key] = arr;
        pendingList = { obj: current, key, arr };
      } else {
        // 顶层空值 → 嵌套容器（metadata:）
        const obj: Record<string, unknown> = {};
        data[key] = obj;
        current = obj;
        pendingList = null;
      }
      continue;
    }
    const value = scalar(rawVal);
    if (Array.isArray(value)) {
      current[key] = value;
      pendingList = { obj: current, key, arr: value };
    } else {
      current[key] = value;
      pendingList = null;
    }
  }
  return { data, body };
}

/**
 * 扫描可用技能：内置（可覆盖）→ 全局（~/.czagent/skills）→ 工作区（<cwd>/.czagent/skills）。
 * 同名技能按此顺序高层覆盖低层；目录不存在/缺 SKILL.md 的条目静默跳过。
 */
export async function scanSkills(cwd: string, builtinDir?: string, globalDir = join(homedir(), '.czagent', 'skills')): Promise<SkillMeta[]> {
  const layers: { dir: string; source: SkillSource }[] = [];
  if (builtinDir) layers.push({ dir: builtinDir, source: 'builtin' });
  layers.push({ dir: globalDir, source: 'global' });
  layers.push({ dir: join(cwd, '.czagent', 'skills'), source: 'workspace' });

  const byName = new Map<string, SkillMeta>();
  for (const layer of layers) {
    let entries: string[];
    try {
      entries = await fs.readdir(layer.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillFile = join(layer.dir, entry, 'SKILL.md');
      let raw: string;
      try {
        raw = await fs.readFile(skillFile, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(raw);
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : entry;
      byName.set(name, {
        name,
        description: typeof data.description === 'string' ? data.description : '',
        path: skillFile,
        dir: join(layer.dir, entry),
        source: layer.source,
        body,
      });
    }
  }
  return [...byName.values()];
}

/**
 * 技能是否对该 agent 生效（I13.3，仅逐条）：
 * load(s) = skillOverrides.on → true；skillOverrides.off → false；
 *           否则 跟随全局 = s 不在 disabledSkills（SkillsTab 全局禁用名单）。
 */
export function skillEnabled(name: string, agent: AgentDef | undefined, disabledSkills: string[]): boolean {
  const ov = agent?.skillOverrides?.[name];
  if (ov === 'on') return true;
  if (ov === 'off') return false;
  return !disabledSkills.includes(name);
}

