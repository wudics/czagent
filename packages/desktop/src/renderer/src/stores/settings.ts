import { create } from 'zustand';
import { createDefaultSettings, getProvider } from '@czagent/core';
import type {
  AgentDef,
  Capability,
  CapabilityBinding,
  GeneralSettings,
  ModelConfig,
  PermissionRule,
  ProviderConfig,
  Settings,
} from '@czagent/core';
import i18n from '../lib/i18n';
import { applyTheme } from '../lib/theme';

/** 内置默认权限规则（恢复默认 / 标记来源用） */
export const defaultPermissionRules: PermissionRule[] = createDefaultSettings().permissions.default;

function ensureChatModelId(models: ModelConfig[], id: string): string {
  const m = models.find((x) => x.id === id);
  if (m) return id;
  return models.find((x) => x.capability === 'chat' && x.enabled)?.id ?? '';
}

function ensureBindingModelId(bindings: CapabilityBinding[], capability: Capability, models: ModelConfig[]): string {
  const current = bindings.find((b) => b.capability === capability)?.modelId;
  if (current && models.some((m) => m.id === current && m.enabled)) return current;
  return models.find((m) => m.capability === capability && m.enabled)?.id ?? '';
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load(): Promise<void>;
  persist(next: Settings): Promise<void>;
  updateProvider(id: string, patch: Partial<ProviderConfig>): Promise<void>;
  addProvider(p: Omit<ProviderConfig, 'id'>): Promise<void>;
  removeProvider(id: string): Promise<void>;
  updateModel(id: string, patch: Partial<ModelConfig>): Promise<void>;
  addModel(m: Omit<ModelConfig, 'id'>): Promise<void>;
  removeModel(id: string): Promise<void>;
  updateBinding(capability: Capability, modelId: string): Promise<void>;
  updateAgent(id: string, patch: Partial<AgentDef>): Promise<void>;
  addAgent(a: Omit<AgentDef, 'id'>): Promise<void>;
  removeAgent(id: string): Promise<void>;
  updateRule(index: number, rule: PermissionRule): Promise<void>;
  addRule(rule: PermissionRule): Promise<void>;
  removeRule(index: number): Promise<void>;
  resetRules(): Promise<void>;
  updateGeneral(patch: Partial<GeneralSettings>): Promise<void>;
  chatModels(): ModelConfig[];
  modelById(id: string): ModelConfig | undefined;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: {
    providers: [],
    models: [],
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

  async updateProvider(id, patch) {
    const { settings, persist } = get();
    await persist({
      ...settings,
      providers: settings.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  },

  async addProvider(p) {
    const { settings, persist } = get();
    const provider: ProviderConfig = { id: nextId('prov'), ...p };
    await persist({ ...settings, providers: [...settings.providers, provider] });
  },

  async removeProvider(id) {
    const { settings, persist } = get();
    const models = settings.models.filter((m) => m.provider !== id);
    const bindings = settings.bindings.map((b) => ({ ...b, modelId: ensureBindingModelId(settings.bindings, b.capability, models) }));
    await persist({
      ...settings,
      providers: settings.providers.filter((p) => p.id !== id),
      models,
      bindings,
    });
  },

  async updateModel(id, patch) {
    const { settings, persist } = get();
    const models = settings.models.map((m) => (m.id === id ? { ...m, ...patch } : m));
    // 改名：绑定映射到新 id（不可走 ensureBindingModelId——旧 id 已不存在会被静默重绑到其他模型）
    const renamed = typeof patch.id === 'string' && patch.id !== id;
    const bindings = renamed
      ? settings.bindings.map((b) => (b.modelId === id ? { ...b, modelId: patch.id! } : b))
      : settings.bindings.map((b) => ({ ...b, modelId: ensureBindingModelId(settings.bindings, b.capability, models) }));
    await persist({ ...settings, models, bindings });
  },

  async addModel(m) {
    const { settings, persist } = get();
    const model: ModelConfig = { id: nextId('model'), ...m };
    await persist({ ...settings, models: [...settings.models, model] });
  },

  async removeModel(id) {
    const { settings, persist } = get();
    const models = settings.models.filter((m) => m.id !== id);
    const bindings = settings.bindings.map((b) => ({ ...b, modelId: ensureBindingModelId(settings.bindings, b.capability, models) }));
    await persist({ ...settings, models, bindings });
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

  chatModels() {
    return get().settings.models.filter((m) => m.capability === 'chat' && m.enabled);
  },

  modelById(id) {
    return get().settings.models.find((m) => m.id === id);
  },
}));

export { ensureChatModelId };
