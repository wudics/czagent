import type { AgentDef, CapabilityBinding, PermissionRule, Settings } from './provider.js';

export const DEFAULT_BINDINGS: CapabilityBinding[] = [
  { capability: 'chat', modelId: '' },
  { capability: 'image-understanding', modelId: '' },
  { capability: 'embedding', modelId: '' },
  { capability: 'rerank', modelId: '' },
  { capability: 'image-generation', modelId: '' },
  { capability: 'video-generation', modelId: '' },
  { capability: 'tts', modelId: '' },
  { capability: 'asr', modelId: '' },
];

const BUILD_AGENT: AgentDef = {
  id: 'build',
  name: 'Build',
  description: '默认执行模式：可自主调用全部工具完成任务',
  systemPrompt:
    '你是一个可靠的桌面智能体，默认处于 Build 模式。\n你可以使用工具读取、修改文件、执行命令、搜索代码与网络。\n在动手前先确认目标；文件修改遵循会话工作目录权限边界（工作目录内可直接写入，目录外需用户确认）。\n多步任务用 todo 工具建清单并只用 statuses 推进进度；互相独立的调研/实现类子任务可用 task 工具派遣子代理执行（prompt 自包含），避免自己串行做完所有事。',
  tools: [],
  permission: { allow: ['read', 'grep', 'glob'], deny: [], ask: ['bash'] },
  builtin: true,
};

const PLAN_AGENT: AgentDef = {
  id: 'plan',
  name: 'Plan',
  description: '规划模式：只读调研、提交计划，经用户确认后切换 Build 执行',
  systemPrompt:
    '你处于 Plan 模式，只能进行只读操作。\n先调研现状（读文件/搜索/抓取网页），然后调用 plan 工具提交清晰的分步实施计划。\n计划提交后调用 plan-exit 工具请求用户确认切换到 Build 模式执行；用户未确认前不要尝试修改任何文件。',
  tools: ['read', 'grep', 'glob', 'webfetch', 'websearch', 'skill', 'plan', 'plan-exit'],
  // plan-exit 规则层放行：用户确认在工具内部通过 ctx.ask 完成（避免双重询问）
  permission: { allow: ['read', 'grep', 'glob', 'webfetch', 'websearch', 'skill', 'plan', 'plan-exit'], deny: ['write', 'edit', 'patch'], ask: [] },
  builtin: true,
};

export const DEFAULT_AGENTS: AgentDef[] = [BUILD_AGENT, PLAN_AGENT];

/**
 * 基础行为规范（P1-②）：代码常量而非用户持久化——随版本演进、免迁移，
 * 经 composeSystemPrompt 前置于所有 agent（build/plan/自定义/子代理）的 systemPrompt。
 * 与 Plan 只读约束冲突时以只读为准（末行显式声明）。
 */
export const BASE_PROMPT = `# 执行风格
- 直接切中要点；完成后即停，不附加"我做了什么"的总结，除非用户要求；与用户交流用中文，代码/命令/报错保持原文。

# 工具使用策略
- 互相独立的工具调用（并行读多个文件、多次独立搜索）在同一条回复中并行发起；有依赖的调用等前序结果。
- 优先用专用工具：读文件用 read、内容搜索用 grep、按名找文件用 glob、改文件用 edit/write；bash 只用于终端操作（构建/git/进程等），不要用 cat/sed/echo 读写文件。

# 代码约定
- 改动前先读目标文件及周边（尤其 import 与相邻实现），模仿现有风格、复用既有工具函数。
- 不假设库可用：使用第三方库前先查 package.json 或相邻 import。
- 不加注释除非被要求；遵循安全实践：不硬编码/打印密钥；不主动 commit 除非明确要求。

# 主动性
- 只做被要求的事：不顺带重构无关部分；发现相邻问题优先告知而非直接修。
- 信息不足且有实质歧义时用 question 澄清；能自行查证的先查证。

# 代码引用与验证
- 引用具体代码位置时用 \`文件路径:行号\` 格式（如 src/foo.ts:42），便于用户定位。
- 完成代码任务后，若项目存在 lint/typecheck/test 脚本（查 package.json scripts），主动运行验证；没有则说明验证方式。
- 与 Plan 模式只读约束冲突时，以只读约束为准。`;

/** system prompt 组装：BASE_PROMPT（代码常量）+ agent.systemPrompt（用户可编辑） */
export function composeSystemPrompt(agent?: { systemPrompt?: string }): string {
  const parts = [BASE_PROMPT, agent?.systemPrompt].filter((s) => s && s.trim());
  return parts.join('\n\n');
}

/** 子代理附加段（P1-④）：task 派遣的隔离上下文行为约束，由 runSubAgent 拼在 composeSystemPrompt 之后 */
export const SUB_AGENT_ADDENDUM = `你是被主会话派遣的子代理：只执行 prompt 中分配的任务，看不到主对话历史；不要向用户提问（question 不可用），信息不足时基于任务描述做合理假设并在报告中注明。完成后输出一份自包含的最终报告（结论/改动文件/关键决定/未尽事项），主会话会直接引用，不面向最终用户排版。`;


/** 全局默认策略改由 tools/policy.ts 的 DEFAULT_TOOL_POLICY 集中定义（矩阵：存储只存偏离，故出厂为空） */
export const DEFAULT_PERMISSIONS: { default: PermissionRule[] } = {
  default: [],
};

export const DEFAULT_GENERAL = {
  language: 'zh-CN' as const,
  theme: 'system' as const,
  maxConcurrency: 4,
  titleAutoRounds: 1,
  continueLoopOnDeny: false,
  websearch: {
    engines: ['bing', 'baidu', 'so360', 'sogou'],
    maxResults: 8,
    ai: { baidu: { enabled: false, apiKey: '' }, exa: { enabled: false, apiKey: '' } },
  },
  compaction: { auto: true, reservedTokens: 20_000, preserveRatio: 0.25 },
  disabledSkills: [],
  scriptTimeoutMinutes: 0,
  chatInitialMessages: 10,
  chatPageMessages: 20,
};

export function createDefaultSettings(): Settings {
  return {
    chatModels: [],
    multimodalModels: [],
    bindings: DEFAULT_BINDINGS.map((b) => ({ ...b })),
    agents: DEFAULT_AGENTS.map((a) => ({ ...a, permission: { ...a.permission }, tools: [...a.tools] })),
    permissions: { default: DEFAULT_PERMISSIONS.default.map((r) => ({ ...r })) },
    general: {
      ...DEFAULT_GENERAL,
      websearch: { ...DEFAULT_GENERAL.websearch, engines: [...DEFAULT_GENERAL.websearch.engines] },
      compaction: { ...DEFAULT_GENERAL.compaction },
    },
  };
}

export function mergeSettings(settings: Settings, patch: Partial<Settings>): Settings {
  return {
    ...settings,
    ...patch,
    general: patch.general
      ? { ...settings.general, ...patch.general, compaction: { ...settings.general.compaction, ...patch.general.compaction } }
      : settings.general,
  };
}
