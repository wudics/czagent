import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { AgentDef, PermissionRule } from '../provider.js';
import { defaultToolPolicy } from '../tools/policy.js';

export type ToolPermissionMode = 'allow' | 'deny' | 'ask';

/**
 * 权限模式匹配（矩阵）：支持 通配 `*`（全）、尾缀 `*`（前缀）、精确 id。
 * 例：`mcp_*` 命中全部 MCP 工具。全局通配规则可覆盖内置矩阵之外的动态工具。
 */
export function matchesRule(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/** agent 侧显式权限覆盖（toolOverrides.mode 优先，其次遗留 permission.*） */
function agentModeOverride(agent: AgentDef, tool: string): { mode: ToolPermissionMode; reason: string } | undefined {
  const ov = agent.toolOverrides?.[tool]?.mode;
  if (ov) return { mode: ov, reason: 'agent.override' };
  if (agent.permission.allow.some((p) => matchesRule(p, tool))) return { mode: 'allow', reason: 'agent.allow' };
  if (agent.permission.deny.some((p) => matchesRule(p, tool))) return { mode: 'deny', reason: 'agent.deny' };
  if (agent.permission.ask.some((p) => matchesRule(p, tool))) return { mode: 'ask', reason: 'agent.ask' };
  return undefined;
}

export interface PermissionCheckInput {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  agent?: AgentDef;
  rules: PermissionRule[];
}

export function checkPermission(input: PermissionCheckInput): { mode: ToolPermissionMode; reason?: string } {
  const { tool, agent, rules } = input;
  if (agent) {
    const override = agentModeOverride(agent, tool);
    if (override) return { mode: override.mode, reason: override.reason };
  }
  const rule = rules.find((r) => matchesRule(r.tool, tool));
  if (rule) return { mode: rule.mode, reason: 'rule' };
  return { mode: defaultToolPolicy(tool).mode, reason: 'default' };
}

/** 供权限弹窗展示目标路径 */
export function extractTargetPath(cwd: string, tool: string, args: Record<string, unknown>): string | undefined {
  const file = args.file;
  if (typeof file === 'string') return resolvePath(cwd, file);
  return undefined;
}

export function resolvePath(cwd: string, p: string): string {
  if (!p) return resolve(cwd);
  if (isAbsolute(p)) return normalize(p);
  return resolve(join(cwd, p));
}

/** 判断 target 是否位于 base 目录内（Windows 大小写不敏感） */
export function pathInside(base: string, target: string): boolean {
  const b = normalize(base);
  const t = normalize(target);
  const bl = b.toLowerCase();
  const tl = t.toLowerCase();
  if (tl === bl) return true;
  const prefix = bl.endsWith('/') || bl.endsWith('\\') ? bl : bl + normalize('/');
  return tl.startsWith(prefix);
}

const DANGEROUS_BASH_RE =
  /\b(rm\s+(-[a-z]*[rR][a-z]*\s+)?[/\\][a-z]:|rm\s+(-[a-z]*[rR][a-z]*\s+)?[/\\]|del\s+\/f\s+\/s|rd\s+\/s\s+\/q|format\s+[a-z]:|shutdown|reboot|poweroff|mkfs\b|dd\s+if=\/dev\/zero|:\(\)\{\:\|\:&\}\:|chmod\s+-R\s+777\s+[/\\]|sudo\s+rm|Remove-Item\s+.*-Recurse|curl\s+[^\|]*\|\s*(sh|bash)|wget\s+[^\|]*\|\s*(sh|bash)|iwr\s+.*\|\s*iex|Invoke-Expression)/i;

/**
 * bash 命令安全分类：危险/破坏性命令 → ask；其余默认 allow（shell 以会话 cwd 运行，天然在 cwd 内）。
 */
export function classifyBashCommand(command: string): { mode: 'allow' | 'ask'; reason?: string } {
  if (!command.trim()) return { mode: 'allow' };
  if (DANGEROUS_BASH_RE.test(command)) {
    return { mode: 'ask', reason: 'dangerous-command' };
  }
  return { mode: 'allow' };
}
