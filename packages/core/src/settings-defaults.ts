import type { AgentDef, CapabilityBinding, ModelConfig, PermissionRule, ProviderConfig, Settings } from './provider.js';

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '', enabled: true, kind: 'builtin' },
  { id: 'siliconflow', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', enabled: true, kind: 'builtin' },
  { id: 'agnes', name: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: '', enabled: true, kind: 'builtin' },
];

export const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'deepseek-v4-pro', provider: 'deepseek', name: 'DeepSeek V4 Pro', capability: 'chat', contextLimit: 1_000_000, maxOutput: 393_216, enabled: true, builtin: true },
  { id: 'deepseek-v4-flash', provider: 'deepseek', name: 'DeepSeek V4 Flash', capability: 'chat', contextLimit: 1_000_000, maxOutput: 393_216, enabled: true, builtin: true },
  { id: 'deepseek-ai/DeepSeek-V4-Flash', provider: 'siliconflow', name: 'deepseek-ai/DeepSeek-V4-Flash', capability: 'chat', contextLimit: 1_000_000, maxOutput: 32_768, enabled: true, builtin: true, vision: false },
  { id: 'Qwen/Qwen3-32B', provider: 'siliconflow', name: 'Qwen/Qwen3-32B', capability: 'chat', contextLimit: 128_000, maxOutput: 32_768, enabled: true, builtin: true },
  { id: 'agnes-2.5-flash', provider: 'agnes', name: 'Agnes 2.5 Flash', capability: 'chat', contextLimit: 524_288, maxOutput: 65_536, enabled: true, builtin: true },
  { id: 'agnes-2.5-pro', provider: 'agnes', name: 'Agnes 2.5 Pro', capability: 'chat', contextLimit: 1_000_000, maxOutput: 65_536, enabled: true, builtin: true },
  { id: 'BAAI/bge-m3', provider: 'siliconflow', name: 'BAAI/bge-m3', capability: 'embedding', contextLimit: 8192, maxOutput: 1024, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'BAAI/bge-reranker-v2-m3', provider: 'siliconflow', name: 'BAAI/bge-reranker-v2-m3', capability: 'rerank', contextLimit: 8192, maxOutput: 1024, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'agnes-image-2.1-flash', provider: 'agnes', name: 'Agnes Image 2.1 Flash', capability: 'image-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'agnes-image-2.5-flash', provider: 'agnes', name: 'agnes-image-2.5-flash', capability: 'image-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'Kwai-Kolors/Kolors', provider: 'siliconflow', name: 'Kwai-Kolors/Kolors', capability: 'image-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'agnes-video-v2.0', provider: 'agnes', name: 'agnes-video-v2.0', capability: 'video-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'agnes-video-2.5-flash', provider: 'agnes', name: 'agnes-video-2.5-flash', capability: 'video-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'Wan-AI/Wan2.2-I2V-A14B', provider: 'siliconflow', name: 'Wan-AI/Wan2.2-I2V-A14B', capability: 'video-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'Wan-AI/Wan2.2-T2V-A14B', provider: 'siliconflow', name: 'Wan-AI/Wan2.2-T2V-A14B', capability: 'video-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'fnlp/MOSS-TTSD-v0.5', provider: 'siliconflow', name: 'fnlp/MOSS-TTSD-v0.5', capability: 'tts', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
  { id: 'FunAudioLLM/SenseVoiceSmall', provider: 'siliconflow', name: 'FunAudioLLM/SenseVoiceSmall', capability: 'asr', contextLimit: 0, maxOutput: 0, enabled: true, builtin: true, toolcall: false, vision: false },
];

export const DEFAULT_BINDINGS: CapabilityBinding[] = [
  { capability: 'chat', modelId: 'deepseek-v4-pro' },
  { capability: 'image-understanding', modelId: 'agnes-2.5-flash' },
  { capability: 'embedding', modelId: 'BAAI/bge-m3' },
  { capability: 'rerank', modelId: 'BAAI/bge-reranker-v2-m3' },
  { capability: 'image-generation', modelId: 'agnes-image-2.1-flash' },
  { capability: 'video-generation', modelId: 'agnes-video-2.5-flash' },
  { capability: 'tts', modelId: 'fnlp/MOSS-TTSD-v0.5' },
  { capability: 'asr', modelId: 'FunAudioLLM/SenseVoiceSmall' },
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

/** 全局默认策略改由 tools/policy.ts 的 DEFAULT_TOOL_POLICY 集中定义（矩阵：存储只存偏离，故出厂为空） */
export const DEFAULT_PERMISSIONS: { default: PermissionRule[] } = {
  default: [],
};

export const DEFAULT_GENERAL = {
  language: 'zh-CN' as const,
  theme: 'system' as const,
  maxConcurrency: 4,
  titleAutoRounds: 1,
  websearch: { engines: ['bing', 'baidu', 'so360', 'sogou'], maxResults: 8 },
  compaction: { auto: true, reservedTokens: 20_000, preserveRatio: 0.25 },
  disabledSkills: [],
  scriptTimeoutMinutes: 0,
  chatInitialMessages: 10,
  chatPageMessages: 20,
};

export function createDefaultSettings(): Settings {
  return {
    providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })),
    models: DEFAULT_MODELS.map((m) => ({ ...m, options: m.options ? { ...m.options } : undefined })),
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
