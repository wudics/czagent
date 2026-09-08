export { ping } from './ping.js';
export * from './provider.js';
export * from './settings-defaults.js';
/** 类型再导出（实现依赖 node:fs，仅浏览器入口的类型消费者可用） */
export type { McpConfig, McpServerConfig, McpLayerEntry, McpLayers } from './mcp/config.js';
export type { SkillMeta, SkillSource } from './skills/discovery.js';
/** 工具矩阵默认策略/清单（运行时/权限/UI 共用；无 node 依赖） */
export * from './tools/policy.js';
/** 多模态 profile 解析（纯函数，无 node 依赖；设置页接口实现徽标用） */
export { resolveProfileMeta, detectStyle, styleName, PROFILE_DESCRIPTORS, FEATURE_LABEL } from './adapters/registry.js';
export type { ApiStyle, AdapterPick, MMFeature, ProfileDesc, ProfileMeta } from './adapters/types.js';
/** 上下文用量折算（纯函数；右侧面板上下文百分比用，与自动压缩判定同口径） */
export { usageTotal } from './compaction.js';
