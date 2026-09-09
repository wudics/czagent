import { create } from 'zustand';
import { createDefaultSettings, getProvider } from '@czagent/core';
import type {
  AgentDef,
  Capability,
  CapabilityBinding,
  ChatModelConfig,
  GeneralSettings,
  MultimodalCapability,
  MultimodalModelConfig,
  PermissionRule,
  Settings,
} from '@czagent/core';
import i18n from '../lib/i18n';
import { applyTheme } from '../lib/theme';

/** 内置默认权限规则（恢复默认 / 标记来源用） */
export const defaultPermissionRules: PermissionRule[] = createDefaultSettings().permissions.default;

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 绑定兜底：当前绑定失效时自动换到该能力的第一个启用模型（删除/禁用模型后调用） */
function ensureBindingModelId(bindings: CapabilityBinding[], capability: Capability, chatModels: ChatModelConfig[], mmModels: MultimodalModelConfig[]): string {
  const current = bindings.find((b) => b.capability === capability)?.modelId;
  if (capability === 'chat') {
    if (current && chatModels.some((m) => m.id === current && m.enabled)) return current;
    return chatModels.find((m) => m.enabled)?.id ?? '';
  }
  if (current && mmModels.some((m) => m.id === current && m.enabled && m.capability === capability)) return current;
  return mmModels.find((m) => m.enabled && m.capability === capability)?.id ?? '';
}

function rebindAll(settings: Settings): CapabilityBinding[] {
  return settings.bindings.map((b) => ({
    ...b,
    modelId: ensureBindingModelId(settings.bindings, b.capability, settings.chatModels, settings.multimodalModels),
  }));
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load(): Promise<void>;
  persist(next: Settings): Promise<void>;
  addChatModel(m: Omit<ChatModelConfig, 'id'>): Promise<ChatModelConfig>;
  updateChatModel(id: string, patch: Partial<ChatModelConfig>): Promise<void>;
  removeChatModel(id: string): Promise<void>;
  addMultimodalModel(m: Omit<MultimodalModelConfig, 'id'>): Promise<MultimodalModelConfig>;
  updateMultimodalModel(id: string, patch: Partial<MultimodalModelConfig>): Promise<void>;
  removeMultimodalModel(id: string): Promise<void>;
  updateBinding(capability: Capability, modelId: string): Promise<void>;
  updateAgent(id: string, patch: Partial<AgentDef>): Promise<void>;
  addAgent(a: Omit<AgentDef, 'id'>): Promise<void>;
  removeAgent(id: string): Promise<void>;
  updateRule(index: number, rule: PermissionRule): Promise<void>;
  addRule(rule: PermissionRule): Promise<void>;
  removeRule(index: number): Promise<void>;
  resetRules(): Promise<void>;
  updateGeneral(patch: Partial<GeneralSettings>): Promise<void>;
  /** 启用的对话模型（会话/Agent 模型选择候选） */
  chatModels(): ChatModelConfig[];
  /** 模型内部 id → 配置（chat 与多模态合并查找） */
  modelById(id: string): ChatModelConfig | MultimodalModelConfig | undefined;
  /** 会话模型解析回退链：会话自身 id（有效时）→ chat 绑定 → 第一个启用对话模型；'' = 未配置任何对话模型 */
  resolveChatModelId(sessionModelId?: string): string;
  /** 能力绑定候选：chat → 对话模型；其余 → 对应类型的多模态模型 */
  bindingOptions(capability: Capability): (ChatModelConfig | MultimodalModelConfig)[];
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: {
    chatModels: [],
    multimodalModels: [],
    bindings: [],
    agents: [],
    permissions: { default: [] },
    general: { language: 'zh-CN', theme: 'system', maxConcurrency: 4, titleAutoRounds: 1, websearch: { engines: ['bing', 'baidu', 'so360', 'sogou'], maxResults: 8 }, compaction: { auto: true, reservedTokens: 20000, preserveRatio: 0.25 }, chatInitialMessages: 10, chatPageMessages: 20 },
  },
  loaded: false,

  async load() {
    const settings = await getProvider().getSettings();
    applyTheme(settings.general.theme);
    set({ settings, loaded: true });
  },

  async persist(next: Settings) {
    set({ settings: next });
    await getProvider().updateSettings(next);
  },

  async addChatModel(m) {
    const { settings, persist } = get();
    const model: ChatModelConfig = { id: nextId('mdl'), ...m };
    await persist({ ...settings, chatModels: [...settings.chatModels, model] });
    return model;
  },

  async updateChatModel(id, patch) {
    const { settings, persist } = get();
    await persist({
      ...settings,
      chatModels: settings.chatModels.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      // 启用状态变化可能使现有绑定失效 → 兜底重绑
      bindings: patch.enabled === false ? rebindAll({ ...settings, chatModels: settings.chatModels.map((m) => (m.id === id ? { ...m, ...patch } : m)) }) : settings.bindings,
    });
  },

  async removeChatModel(id) {
    const { settings, persist } = get();
    const next = { ...settings, chatModels: settings.chatModels.filter((m) => m.id !== id) };
    await persist({ ...next, bindings: rebindAll(next) });
  },

  async addMultimodalModel(m) {
    const { settings, persist } = get();
    const model: MultimodalModelConfig = { id: nextId('mdl'), ...m };
    await persist({ ...settings, multimodalModels: [...settings.multimodalModels, model] });
    return model;
  },

  async updateMultimodalModel(id, patch) {
    const { settings, persist } = get();
    await persist({
      ...settings,
      multimodalModels: settings.multimodalModels.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  },

  async removeMultimodalModel(id) {
    const { settings, persist } = get();
    const next = { ...settings, multimodalModels: settings.multimodalModels.filter((m) => m.id !== id) };
    await persist({ ...next, bindings: rebindAll(next) });
  },

  async updateBinding(capability, modelId) {
    const { settings, persist } = get();
    await persist({
      ...settings,
      bindings: settings.bindings.map((b) => (b.capability === capability ? { ...b, modelId } : b)),
    });
  },

  async updateAgent(id, patch) {
    const { settings, persist } = get();
    await persist({ ...settings, agents: settings.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  },

  async addAgent(a) {
    const { settings, persist } = get();
    const agent: AgentDef = { id: nextId('agent'), ...a };
    await persist({ ...settings, agents: [...settings.agents, agent] });
  },

  async removeAgent(id) {
    const { settings, persist } = get();
    await persist({ ...settings, agents: settings.agents.filter((a) => a.id !== id) });
  },

  async updateRule(index, rule) {
    const { settings, persist } = get();
    const rules = [...settings.permissions.default];
    rules[index] = rule;
    await persist({ ...settings, permissions: { default: rules } });
  },

  async addRule(rule) {
    const { settings, persist } = get();
    await persist({ ...settings, permissions: { default: [...settings.permissions.default, rule] } });
  },

  async removeRule(index) {
    const { settings, persist } = get();
    const rules = settings.permissions.default.filter((_, i) => i !== index);
    await persist({ ...settings, permissions: { default: rules } });
  },

  async resetRules() {
    const { settings, persist } = get();
    await persist({ ...settings, permissions: { default: defaultPermissionRules.map((r) => ({ ...r })) } });
  },

  async updateGeneral(patch) {
    const { settings, persist } = get();
    const next = {
      ...settings,
      general: {
        ...settings.general,
        ...patch,
        compaction: { ...settings.general.compaction, ...(patch.compaction ?? {}) },
      },
    };
    if (patch.language) void i18n.changeLanguage(patch.language);
    if (patch.theme) applyTheme(patch.theme);
    await persist(next);
  },

  // ⚠️ 返回每次新建的数组：仅供命令式调用（非 hook 场景）；hook 中请 selector 选 `settings` 后自行 useMemo 派生，
  // 否则 selector snapshot 不稳定会导致 useSyncExternalStore 无限重渲染
  chatModels() {
    return get().settings.chatModels.filter((m) => m.enabled);
  },

  // 返回对象引用稳定，可用于 hook selector
  modelById(id) {
    const { settings } = get();
    return settings.chatModels.find((m) => m.id === id) ?? settings.multimodalModels.find((m) => m.id === id);
  },

  resolveChatModelId(sessionModelId) {
    const { settings } = get();
    const enabled = settings.chatModels.filter((m) => m.enabled);
    if (sessionModelId && enabled.some((m) => m.id === sessionModelId)) return sessionModelId;
    const bound = settings.bindings.find((b) => b.capability === 'chat')?.modelId;
    if (bound && enabled.some((m) => m.id === bound)) return bound;
    return enabled[0]?.id ?? '';
  },

  // ⚠️ 返回每次新建的数组：仅供组件体内直接调用（非 selector）；不可作为 zustand selector 的返回值
  bindingOptions(capability) {
    const { settings } = get();
    if (capability === 'chat') {
      return settings.chatModels.filter((m) => m.enabled);
    }
    const cap = capability as MultimodalCapability;
    return settings.multimodalModels.filter((m) => m.enabled && m.capability === cap);
  },
}));
