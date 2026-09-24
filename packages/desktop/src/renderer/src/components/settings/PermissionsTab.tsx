import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { PermissionRule } from '@czagent/core';
import { defaultToolPolicy, globalToolPolicy, TOOL_INVENTORY } from '@czagent/core';
import { useSettingsStore } from '../../stores/settings';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { Field, NumInput, Section, TextInput } from './fields';

type ToolPermissionMode = 'allow' | 'deny' | 'ask';

const SECTION_TITLE: Record<string, string> = {
  file: 'tools.sections.file',
  shell: 'tools.sections.shell',
  web: 'tools.sections.web',
  media: 'tools.sections.media',
  skill: 'tools.sections.skill',
  plan: 'tools.sections.plan',
  interact: 'tools.sections.interact',
};
const MODES: ToolPermissionMode[] = ['allow', 'deny', 'ask'];
const BUILTIN = new Set(TOOL_INVENTORY.map((t) => t.id));

const DEFAULT_ENGINES = ['bing', 'baidu', 'so360', 'sogou'];
const AI_ENGINES = [
  { key: 'baidu' as const, label: 'settings.permissions.aiEngines.baidu', docs: 'https://console.bce.baidu.com/qianfan/' },
  { key: 'exa' as const, label: 'settings.permissions.aiEngines.exa', docs: 'https://dashboard.exa.ai/api-keys' },
];

/** 某内置工具当前存储规则（偏离） */
function storedRule(rules: PermissionRule[], tool: string): PermissionRule | undefined {
  return rules.find((r) => r.tool === tool);
}

/** 规则与默认策略是否一致（一致 = 无需存储偏离行） */
function matchesDefault(rule: PermissionRule | undefined, tool: string): boolean {
  const d = defaultToolPolicy(tool);
  if (!rule) return true;
  return (rule.enabled ?? true) === d.enabled && rule.mode === d.mode;
}

export function PermissionsTab() {
  const { t } = useTranslation();
  const rules = useSettingsStore((s) => s.settings.permissions.default);
  const updateRule = useSettingsStore((s) => s.updateRule);
  const addRule = useSettingsStore((s) => s.addRule);
  const removeRule = useSettingsStore((s) => s.removeRule);
  const general = useSettingsStore((s) => s.settings.general);
  const updateGeneral = useSettingsStore((s) => s.updateGeneral);
  const [newPattern, setNewPattern] = useState('mcp_*');

  const wildcardRules = rules.filter((r) => !BUILTIN.has(r.tool));

  /** websearch 局部更新：保留其余字段（engines/maxResults/ai 按需覆盖） */
  const patchWebsearch = (patch: Partial<NonNullable<typeof general.websearch>>): void => {
    const ws = general.websearch;
    void updateGeneral({
      websearch: { engines: ws?.engines ?? [...DEFAULT_ENGINES], maxResults: ws?.maxResults ?? 8, ai: ws?.ai, ...patch },
    });
  };
  const patchAi = (key: 'baidu' | 'exa', p: { enabled?: boolean; apiKey?: string }): void => {
    const entry = { enabled: false, apiKey: '', ...general.websearch?.ai?.[key], ...p };
    patchWebsearch({ ai: { ...general.websearch?.ai, [key]: entry } });
  };

  /** 写入某工具偏离：与默认一致则移除行（只存偏离） */
  const setTool = (tool: string, next: { enabled: boolean; mode: ToolPermissionMode }): void => {
    const d = defaultToolPolicy(tool);
    const idx = rules.findIndex((r) => r.tool === tool);
    const { enabled, mode } = next;
    if (enabled === d.enabled && mode === d.mode) {
      if (idx >= 0) void removeRule(idx);
      return;
    }
    const row: PermissionRule = { tool, mode, enabled };
    if (idx >= 0) void updateRule(idx, row);
    else void addRule(row);
  };

  const resetBuiltins = (): void => {
    // 移除所有内置工具的偏离（保留通配补充规则）
    const keep = rules.filter((r) => !BUILTIN.has(r.tool));
    void useSettingsStore.getState().persist({
      ...useSettingsStore.getState().settings,
      permissions: { default: keep },
    });
  };

  const removeAt = (rule: PermissionRule): void => {
    const idx = rules.findIndex((r) => r.tool === rule.tool && r.mode === rule.mode && r.enabled === rule.enabled);
    if (idx >= 0) void removeRule(idx);
  };

  return (
    <div className="space-y-6">
      <Section
        title={t('settings.permissions.title')}
        action={
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" title={t('settings.permissions.reset')} onClick={() => void resetBuiltins()}>
              <RotateCcw size={14} />
            </Button>
          </div>
        }
      >
        <p className="mb-2 text-xs text-muted-foreground">{t('settings.permissions.matrixHint')}</p>
        {(['file', 'shell', 'web', 'media', 'skill', 'plan', 'interact'] as const).map((section) => {
          const items = TOOL_INVENTORY.filter((x) => x.section === section);
          if (items.length === 0) return null;
          return (
            <div key={section} className="mb-2 rounded-md border border-border p-2">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{t(SECTION_TITLE[section]!)}</p>
              {items.map((it) => {
                const eff = globalToolPolicy(rules, it.id);
                const rule = storedRule(rules, it.id);
                const isDefault = matchesDefault(rule, it.id);
                return (
                  <div key={it.id} className="flex items-center gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      <span className={isDefault ? 'text-muted-foreground' : ''}>{t(`tools.labels.${it.id}`)}</span>
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/60">{it.id}</span>
                      {!isDefault && <span className="ml-1.5 rounded bg-amber-500/10 px-1 text-[10px] text-amber-600">{t('settings.permissions.custom')}</span>}
                    </span>
                    <Switch
                      checked={eff.enabled}
                      onCheckedChange={(v) => void setTool(it.id, { enabled: v, mode: eff.mode })}
                      aria-label={`${it.id} enabled`}
                    />
                    <Select
                      className="w-24 text-xs"
                      value={eff.mode}
                      onChange={(e) => void setTool(it.id, { enabled: eff.enabled, mode: e.target.value as ToolPermissionMode })}
                      aria-label={`${it.id} mode`}
                    >
                      {MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  </div>
                );
              })}
            </div>
          );
        })}
      </Section>

      <Section
        title={t('settings.permissions.extraRules')}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const tool = newPattern.trim();
              if (tool && !rules.some((r) => r.tool === tool)) void addRule({ tool, mode: 'allow' });
              else if (tool) {
                const dup = rules.find((r) => r.tool === tool);
                if (dup) return;
              }
            }}
          >
            <Plus size={14} />
            {t('settings.permissions.add')}
          </Button>
        }
      >
        <p className="mb-2 text-xs text-muted-foreground">{t('settings.permissions.extraHint')}</p>
        <div className="mb-2 flex items-center gap-2">
          <TextInput value={newPattern} onChange={(e) => setNewPattern(e.target.value)} placeholder="mcp_*" className="h-8 w-44 font-mono" />
        </div>
        <div className="space-y-2">
          {wildcardRules.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.permissions.noExtra')}</p>}
          {wildcardRules.map((r) => (
            <div key={r.tool} className="flex items-center gap-2">
              <TextInput value={r.tool} className="h-8 w-44 font-mono" />
              <Select className="w-24" value={r.mode} onChange={(e) => void updateRule(rules.indexOf(r), { ...r, mode: e.target.value as PermissionRule['mode'] })}>
                <option value="allow">allow</option>
                <option value="deny">deny</option>
                <option value="ask">ask</option>
              </Select>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeAt(r)}>
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('settings.permissions.websearch')}>
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.permissions.websearchHint')}</p>
        <div className="grid grid-cols-2 gap-4">
          {(['bing', 'baidu', 'so360', 'sogou'] as const).map((id) => (
            <div key={id} className="flex items-center justify-between">
              <span className="text-sm">{t(`settings.permissions.engines.${id}`)}</span>
              <Switch
                checked={(general.websearch?.engines ?? DEFAULT_ENGINES).includes(id)}
                onCheckedChange={(on) => {
                  const engines = general.websearch?.engines ?? DEFAULT_ENGINES;
                  const next = on ? [...engines, id] : engines.filter((e) => e !== id);
                  patchWebsearch({ engines: next });
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">{t('settings.permissions.aiSearchHint')}</p>
          {AI_ENGINES.map(({ key, label, docs }) => {
            const entry = general.websearch?.ai?.[key];
            const enabled = entry?.enabled ?? false;
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm">{t(label)}</span>
                  <Switch checked={enabled} onCheckedChange={(on) => patchAi(key, { enabled: on })} />
                </div>
                <TextInput
                  type="password"
                  value={entry?.apiKey ?? ''}
                  onChange={(e) => patchAi(key, { apiKey: e.target.value })}
                  placeholder={t('settings.permissions.aiApiKey')}
                  className="font-mono"
                />
                {enabled && !entry?.apiKey?.trim() ? (
                  <p className="text-xs text-amber-500">{t('settings.permissions.aiKeyMissing', { docs })}</p>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="mt-4">
          <Field label={t('settings.permissions.maxResults')}>
            <NumInput
              min={1}
              max={20}
              value={general.websearch?.maxResults ?? 8}
              onChange={(e) => patchWebsearch({ maxResults: Math.min(20, Math.max(1, Number(e.target.value) || 8)) })}
            />
          </Field>
        </div>
      </Section>
    </div>
  );
}
