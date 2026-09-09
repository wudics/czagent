import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { AgentDef, LoadValue, McpLayerEntry, SkillMeta, ToolOverride } from '@czagent/core';
import { agentLoad, materializeAgentMatrix, TOOL_INVENTORY } from '@czagent/core';
import { useSettingsStore } from '../../stores/settings';
import { useSessionsStore } from '../../stores/sessions';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Badge } from '../ui/badge';
import { Field, NumInput, Section, TextInput } from './fields';

const TOOL_IDS = TOOL_INVENTORY.map((t) => t.id);
const SECTION_TITLE: Record<string, string> = {
  file: 'tools.sections.file',
  shell: 'tools.sections.shell',
  web: 'tools.sections.web',
  media: 'tools.sections.media',
  skill: 'tools.sections.skill',
  plan: 'tools.sections.plan',
  interact: 'tools.sections.interact',
};
const MODES: ('allow' | 'deny' | 'ask')[] = ['allow', 'deny', 'ask'];

/** 确保 agent 为矩阵形态（遗留 tools/permission → 物化 toolOverrides），返回可写副本 */
function ensureMatrix(agent: AgentDef): AgentDef {
  return agent.toolOverrides ? agent : materializeAgentMatrix(agent, TOOL_IDS);
}

function ToolRow({
  tool,
  load,
  mode,
  onChange,
}: {
  tool: string;
  load: LoadValue;
  mode: 'inherit' | 'allow' | 'deny' | 'ask';
  onChange: (patch: { load?: LoadValue; mode?: 'inherit' | 'allow' | 'deny' | 'ask' }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="text-muted-foreground">{t(`tools.labels.${tool}`)}</span>
        <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/60">{tool}</span>
      </span>
      <Select
        className="w-24 text-xs"
        value={load}
        onChange={(e) => onChange({ load: e.target.value as LoadValue })}
        aria-label={`${tool} load`}
      >
        <option value="follow">{t('settings.agents.row.follow')}</option>
        <option value="on">{t('settings.agents.row.on')}</option>
        <option value="off">{t('settings.agents.row.off')}</option>
      </Select>
      <Select className="w-24 text-xs" value={mode} onChange={(e) => onChange({ mode: e.target.value as typeof mode })} aria-label={`${tool} mode`}>
        <option value="inherit">{t('settings.agents.row.inherit')}</option>
        {MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </Select>
    </div>
  );
}

function MCPThreeState({ agent, entries }: { agent: AgentDef; entries: McpLayerEntry[] }) {
  const { t } = useTranslation();
  const updateAgent = useSettingsStore((s) => s.updateAgent);
  if (entries.length === 0) return null;
  const overrides = agent.mcp ?? {};
  return (
    <div className="space-y-1.5">
      {entries.map((e) => {
        const val = overrides[e.name] ?? 'inherit';
        return (
          <div key={`${e.source}:${e.name}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
            <span className="w-14 text-[11px] text-muted-foreground">{t(`settings.mcp.source.${e.source}`)}</span>
            <Select
              className="w-28"
              value={val}
              onChange={(ev) => {
                const v = ev.target.value as 'on' | 'off' | 'inherit';
                const next = { ...overrides };
                if (v === 'inherit') delete next[e.name];
                else next[e.name] = v;
                void updateAgent(agent.id, { mcp: next });
              }}
            >
              <option value="inherit">{t('settings.agents.mcp.inherit')}</option>
              <option value="on">{t('settings.agents.mcp.on')}</option>
              <option value="off">{t('settings.agents.mcp.off')}</option>
            </Select>
          </div>
        );
      })}
    </div>
  );
}

function AgentEditor({ agent }: { agent: AgentDef }) {
  const { t } = useTranslation();
  const updateAgent = useSettingsStore((s) => s.updateAgent);
  const removeAgent = useSettingsStore((s) => s.removeAgent);
  // selector 只选稳定引用（settings），派生数组在组件内 useMemo（避免 snapshot 不稳定引发无限重渲染）
  const chatSettings = useSettingsStore((s) => s.settings);
  const chatModels = useMemo(() => chatSettings.chatModels.filter((m) => m.enabled), [chatSettings.chatModels]);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const [mcpEntries, setMcpEntries] = useState<McpLayerEntry[]>([]);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const activeCwd = sessions.find((x) => x.id === activeId)?.cwd;

  useEffect(() => {
    let alive = true;
    void window.czagent?.mcpGetLayers?.(activeCwd).then((layers) => {
      if (alive) setMcpEntries(layers.entries);
    });
    void window.czagent?.listSkills?.(activeCwd).then((list) => {
      if (alive) setSkills(list);
    });
    return () => {
      alive = false;
    };
  }, [activeCwd]);

  // 当前行值（矩阵语义，兼容遗留 agent）
  const loadOf = (id: string): LoadValue => agentLoad(agent, id);
  const modeOf = (id: string): 'inherit' | 'allow' | 'deny' | 'ask' => agent.toolOverrides?.[id]?.mode ?? 'inherit';

  const setRow = (tool: string, patch: { load?: LoadValue; mode?: 'inherit' | 'allow' | 'deny' | 'ask' }): void => {
    const base = ensureMatrix(agent);
    const overrides = { ...(base.toolOverrides ?? {}) };
    const prev = overrides[tool] ?? {};
    const next: ToolOverride = { ...prev };
    if (patch.load !== undefined) {
      next.load = patch.load === 'follow' ? undefined : patch.load === 'on';
    }
    if (patch.mode !== undefined) {
      next.mode = patch.mode === 'inherit' ? undefined : patch.mode;
    }
    if (next.load === undefined && next.mode === undefined) delete overrides[tool];
    else overrides[tool] = next;
    void updateAgent(agent.id, { toolOverrides: overrides, tools: base.tools, permission: base.permission });
  };

  const resetAgentTools = (): void => {
    const base = ensureMatrix(agent);
    void updateAgent(agent.id, { toolOverrides: {}, tools: base.tools, permission: base.permission });
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{agent.name}</span>
        {agent.builtin && <Badge variant="outline">{t('settings.agents.builtin')}</Badge>}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={resetAgentTools} title={t('settings.agents.resetTools')}>
            <RotateCcw size={12} />
          </Button>
          {!agent.builtin && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void removeAgent(agent.id)}>
              <Trash2 size={13} />
            </Button>
          )}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('settings.agents.name')}>
          <TextInput value={agent.name} onChange={(e) => void updateAgent(agent.id, { name: e.target.value })} />
        </Field>
        <Field label={t('settings.agents.model')}>
          <Select value={agent.modelId ?? ''} onChange={(e) => void updateAgent(agent.id, { modelId: e.target.value || undefined })}>
            <option value="">—</option>
            {chatModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label={t('settings.agents.description')}>
        <TextInput value={agent.description} onChange={(e) => void updateAgent(agent.id, { description: e.target.value })} />
      </Field>

      <Field label={t('settings.agents.systemPrompt')}>
        <textarea
          className="h-24 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={agent.systemPrompt}
          onChange={(e) => void updateAgent(agent.id, { systemPrompt: e.target.value })}
        />
      </Field>

      <div className="rounded-md border border-border p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{t('settings.agents.matrixTitle')}</span>
        </div>
        <div className="flex items-center gap-2 border-b border-border pb-1 text-[11px] text-muted-foreground">
          <span className="flex-1" />
          <span className="w-24 text-right">{t('settings.agents.loadHeader')}</span>
          <span className="w-24 text-right">{t('settings.agents.modeHeader')}</span>
        </div>
        {(['file', 'shell', 'web', 'media', 'skill', 'plan', 'interact'] as const).map((section) => {
          const items = TOOL_INVENTORY.filter((x) => x.section === section);
          if (items.length === 0) return null;
          return (
            <div key={section} className="mt-1.5">
              <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{t(SECTION_TITLE[section]!)}</p>
              {items.map((it) => (
                <ToolRow key={it.id} tool={it.id} load={loadOf(it.id)} mode={modeOf(it.id)} onChange={(patch) => setRow(it.id, patch)} />
              ))}
            </div>
          );
        })}
      </div>

      {mcpEntries.length > 0 && (
        <Field label={t('settings.agents.mcp.label')} hint={t('settings.agents.mcp.hint')}>
          <MCPThreeState agent={agent} entries={mcpEntries} />
        </Field>
      )}

      <Field label={t('settings.agents.skillsLabel')} hint={t('settings.agents.skillsHint')}>
        {skills.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">{t('settings.agents.noSkills')}</p>
        ) : (
          <div className="space-y-1.5">
            {skills.map((s) => {
              const val = agent.skillOverrides?.[s.name] ?? 'inherit';
              return (
                <div key={`${s.source}:${s.name}`} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="text-muted-foreground">{s.name}</span>
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground/60">{t(`settings.skills.source.${s.source}`)}</span>
                  </span>
                  <Select
                    className="w-28"
                    value={val}
                    onChange={(e) => {
                      const v = e.target.value as 'on' | 'off' | 'inherit';
                      const next = { ...(agent.skillOverrides ?? {}) };
                      if (v === 'inherit') delete next[s.name];
                      else next[s.name] = v;
                      void updateAgent(agent.id, { skillOverrides: next });
                    }}
                  >
                    <option value="inherit">{t('settings.agents.row.inherit')}</option>
                    <option value="on">{t('settings.agents.row.on')}</option>
                    <option value="off">{t('settings.agents.row.off')}</option>
                  </Select>
                </div>
              );
            })}
          </div>
        )}
      </Field>

      <div className="w-40">
        <Field label={t('settings.agents.steps')}>
          <NumInput
            value={agent.steps ?? ''}
            placeholder="∞"
            onChange={(e) => void updateAgent(agent.id, { steps: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
      </div>
    </div>
  );
}

export function AgentsTab() {
  const { t } = useTranslation();
  const agents = useSettingsStore((s) => s.settings.agents);
  const addAgent = useSettingsStore((s) => s.addAgent);

  return (
    <Section
      title={t('settings.agents.title')}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void addAgent({
              name: '新 Agent',
              description: '',
              systemPrompt: '你是一个专注执行特定任务的 Agent。',
              tools: [],
              permission: { allow: [], deny: [], ask: [] },
            })
          }
        >
          <Plus size={14} />
          {t('settings.agents.addAgent')}
        </Button>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">{t('settings.agents.matrixHint')}</p>
      <div className="space-y-4">
        {agents.map((a) => (
          <AgentEditor key={a.id} agent={a} />
        ))}
      </div>
    </Section>
  );
}
