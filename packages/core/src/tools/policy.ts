/** 工具矩阵默认策略与加载链（I13.1）：取代能力组。存储只存偏离，默认策略在此集中定义。 */
import type { AgentDef, PermissionRule } from '../provider.js';
import type { ToolPermissionMode } from '../permission/index.js';

/** 内置工具默认策略：enabled=false 的工具默认不注入（plan 需 agent 强制开） */
const ALLOW_TOOLS = ['read', 'grep', 'glob', 'webfetch', 'websearch', 'skill', 'embed', 'rerank', 'image-generate', 'image-edit', 'video-generate', 'video-from-frame', 'tts', 'asr', 'question', 'todo', 'task'] as const;
const ASK_TOOLS = ['bash', 'write', 'edit', 'patch'] as const;

export interface ToolDefaultPolicy {
  enabled: boolean;
  mode: ToolPermissionMode;
}

export const DEFAULT_TOOL_POLICY: Record<string, ToolDefaultPolicy> = Object.fromEntries([
  ...ALLOW_TOOLS.map((t) => [t, { enabled: true, mode: 'allow' }]),
  ...ASK_TOOLS.map((t) => [t, { enabled: true, mode: 'ask' }]),
  // plan 工具默认关：仅显式"开"的 agent（plan）才拿到
  ['plan', { enabled: false, mode: 'allow' }],
  ['plan-exit', { enabled: false, mode: 'allow' }],
]) as Record<string, ToolDefaultPolicy>;

/** 未知新工具：自动可用（enabled:true）但权限保守（ask） */
export function defaultToolPolicy(tool: string): ToolDefaultPolicy {
  return DEFAULT_TOOL_POLICY[tool] ?? { enabled: true, mode: 'ask' };
}

/** 矩阵展示分组（仅 UI 分区用，无语义） */
export const TOOL_INVENTORY: { id: string; section: 'file' | 'shell' | 'web' | 'media' | 'skill' | 'plan' | 'interact' }[] = [
  { id: 'read', section: 'file' },
  { id: 'grep', section: 'file' },
  { id: 'glob', section: 'file' },
  { id: 'write', section: 'file' },
  { id: 'edit', section: 'file' },
  { id: 'patch', section: 'file' },
  { id: 'bash', section: 'shell' },
  { id: 'webfetch', section: 'web' },
  { id: 'websearch', section: 'web' },
  { id: 'skill', section: 'skill' },
  { id: 'embed', section: 'media' },
  { id: 'rerank', section: 'media' },
  { id: 'image-generate', section: 'media' },
  { id: 'image-edit', section: 'media' },
  { id: 'video-generate', section: 'media' },
  { id: 'video-from-frame', section: 'media' },
  { id: 'tts', section: 'media' },
  { id: 'asr', section: 'media' },
  { id: 'plan', section: 'plan' },
  { id: 'plan-exit', section: 'plan' },
  { id: 'question', section: 'interact' },
  { id: 'task', section: 'interact' },
  { id: 'todo', section: 'plan' },
];

/** 全局某工具当前策略：规则偏离 ?? 默认策略 */
export function globalToolPolicy(rules: PermissionRule[], tool: string): ToolDefaultPolicy {
  const r = rules.find((x) => x.tool === tool);
  if (r) return { enabled: r.enabled ?? true, mode: r.mode };
  return defaultToolPolicy(tool);
}

/** agent 对该工具的"加载"指示：on/off/follow */
export type LoadValue = 'on' | 'off' | 'follow';

export function agentLoad(agent: AgentDef | undefined, tool: string): LoadValue {
  if (!agent) return 'follow';
  if (agent.toolOverrides && typeof agent.toolOverrides[tool]?.load === 'boolean') {
    return agent.toolOverrides[tool]!.load ? 'on' : 'off';
  }
  // 遗留：无 toolOverrides 且 tools 非空 = 白名单（只加载点名工具）
  if (!agent.toolOverrides && agent.tools.length > 0) return agent.tools.includes(tool) ? 'on' : 'off';
  return 'follow';
}

/** 最终"是否注入上下文" */
export function effectiveToolLoaded(agent: AgentDef | undefined, rules: PermissionRule[], tool: string): boolean {
  const load = agentLoad(agent, tool);
  if (load === 'on') return true;
  if (load === 'off') return false;
  return globalToolPolicy(rules, tool).enabled;
}

/**
 * 遗留 agent（无 toolOverrides，tools 为白名单 / permission 为显式 allow-deny-ask）
 * → 物化为 toolOverrides（每工具 load + mode），随后清空 tools/permission 遗留字段。
 * 供矩阵 UI 在首次编辑前调用，避免"部分 toolOverrides + 遗留字段"混合语义。
 */
export function materializeAgentMatrix(agent: AgentDef, toolIds: string[]): AgentDef {
  if (agent.toolOverrides) return agent;
  const whitelist = agent.tools.length > 0;
  const modeOf = (id: string): ToolPermissionMode | undefined => {
    if (agent.permission.allow.some((p) => p === id || p === '*')) return 'allow';
    if (agent.permission.deny.some((p) => p === id || p === '*')) return 'deny';
    if (agent.permission.ask.some((p) => p === id || p === '*')) return 'ask';
    return undefined;
  };
  const overrides: NonNullable<AgentDef['toolOverrides']> = {};
  for (const id of toolIds) {
    const load = whitelist ? agent.tools.includes(id) : true;
    const mode = modeOf(id);
    if (!load || mode) overrides[id] = { load, ...(mode ? { mode } : {}) };
  }
  return { ...agent, tools: [], permission: { allow: [], deny: [], ask: [] }, toolOverrides: overrides };
}
