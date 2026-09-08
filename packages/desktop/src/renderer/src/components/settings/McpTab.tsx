import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Pencil, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { McpLayerEntry, McpServerConfig } from '@czagent/core';
import { useSessionsStore } from '../../stores/sessions';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Switch } from '../ui/switch';
import { Field, Section, TextInput } from './fields';

type TestResult = { ok: boolean; tools: string[]; error?: string };

interface ServerForm {
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

const EMPTY_FORM: ServerForm = { name: '', type: 'stdio', command: '', args: '', env: '', url: '', headers: '' };

/** args 多行文本 ⇄ 数组（每行一个参数） */
function linesToArgs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** env 多行文本 ⇄ 对象（每行 KEY=VALUE） */
function linesToEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** headers 多行文本 ⇄ 对象（每行 Key: Value 或 Key=Value） */
function linesToHeaders(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = Math.min(...[t.indexOf(':'), t.indexOf('=')].filter((n) => n > 0));
    if (!Number.isFinite(i) || i <= 0) continue;
    headers[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function formToConfig(form: ServerForm): McpServerConfig {
  if (form.type === 'http') {
    return { url: form.url.trim(), headers: linesToHeaders(form.headers) };
  }
  return {
    command: form.command.trim(),
    args: linesToArgs(form.args).length > 0 ? linesToArgs(form.args) : undefined,
    env: linesToEnv(form.env),
  };
}

function configToForm(entry: McpLayerEntry): ServerForm {
  const c = entry.config;
  const base: ServerForm = { name: entry.name, type: 'stdio', command: '', args: '', env: '', url: '', headers: '' };
  if ('url' in c) {
    return {
      ...base,
      type: 'http',
      url: c.url,
      headers: Object.entries(c.headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
    };
  }
  return {
    ...base,
    type: 'stdio',
    command: c.command,
    args: (c.args ?? []).join('\n'),
    env: Object.entries(c.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  };
}

function SourceBadge({ source }: { source: 'global' | 'workspace' }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
        source === 'global' ? 'bg-sky-500/15 text-sky-500' : 'bg-violet-500/15 text-violet-500'
      }`}
    >
      {t(`settings.mcp.source.${source}`)}
    </span>
  );
}

export function McpTab() {
  const { t } = useTranslation();
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const cwd = sessions.find((x) => x.id === activeId)?.cwd;
  const [entries, setEntries] = useState<McpLayerEntry[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM);

  const reload = useCallback(async (): Promise<void> => {
    const layers = await window.czagent?.mcpGetLayers?.(cwd);
    if (!layers) return;
    setEntries(layers.entries);
    setWorkspacePath(layers.workspacePath);
  }, [cwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveGlobal = async (next: McpLayerEntry[]): Promise<void> => {
    if (!window.czagent?.mcpSaveGlobal) return;
    const config: Record<string, McpServerConfig> = {};
    for (const e of next.filter((x) => x.source === 'global')) config[e.name] = e.config;
    await window.czagent.mcpSaveGlobal(config);
    await reload();
  };

  const openDialog = (entry?: McpLayerEntry): void => {
    setEditing(entry?.name ?? null);
    setForm(entry ? configToForm(entry) : EMPTY_FORM);
    setDialogOpen(true);
  };

  const submitForm = async (): Promise<void> => {
    const name = form.name.trim();
    if (!name) return;
    const config = formToConfig(form);
    // 编辑时保留原有 enabled 状态（表单不表达启停，由列表行开关控制）
    const original = entries.find((x) => x.source === 'global' && x.name === editing);
    if (original && original.config.enabled === false) config.enabled = false;
    const globalOthers = entries.filter((x) => x.source === 'global' && x.name !== name && x.name !== editing);
    await saveGlobal([...globalOthers, { name, config, source: 'global' }]);
    setDialogOpen(false);
  };

  const toggleEnabled = async (entry: McpLayerEntry, enabled: boolean): Promise<void> => {
    const next = entries.map((e) => (e.source === 'global' && e.name === entry.name ? { ...e, config: { ...e.config, enabled } } : e));
    await saveGlobal(next);
  };

  const remove = async (name: string): Promise<void> => {
    if (!window.confirm(t('settings.mcp.confirmRemove', { name }))) return;
    await saveGlobal(entries.filter((x) => !(x.source === 'global' && x.name === name)));
  };

  const test = async (entry: McpLayerEntry): Promise<void> => {
    const api = window.czagent;
    if (!api?.mcpTestConnection) return;
    setTesting(entry.name);
    try {
      const result = await api.mcpTestConnection(entry.config);
      setTests((m) => ({ ...m, [entry.name]: result }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-6">
      <Section
        title={t('settings.mcp.title')}
        action={
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              <RefreshCw size={14} />
            </Button>
            <Button size="sm" variant="outline" onClick={() => openDialog()}>
              <Plus size={14} />
              {t('settings.mcp.add')}
            </Button>
          </div>
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">
          {t('settings.mcp.hint')}
          {cwd ? '' : ` ${t('settings.mcp.noSessionHint')}`}
        </p>
        <div className="space-y-2">
          {entries.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.mcp.empty')}</p>}
          {entries.map((entry) => {
            const result = tests[entry.name];
            return (
              <div key={`${entry.source}:${entry.name}`} className="rounded-md border border-border p-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.name}</span>
                  <SourceBadge source={entry.source} />
                  <Switch
                    checked={entry.config.enabled !== false}
                    disabled={entry.source !== 'global'}
                    onCheckedChange={(v) => void toggleEnabled(entry, v)}
                  />
                  {'url' in entry.config ? (
                    <span className="max-w-40 truncate text-xs text-muted-foreground">{entry.config.url}</span>
                  ) : (
                    <span className="max-w-40 truncate text-xs text-muted-foreground">{entry.config.command}</span>
                  )}
                  {entry.source === 'global' ? (
                    <>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openDialog(entry)} aria-label={t('settings.mcp.edit')}>
                        <Pencil size={13} />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void remove(entry.name)} aria-label={t('settings.mcp.remove')}>
                        <Trash2 size={13} />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void window.czagent?.openPath?.(workspacePath)}
                      aria-label={t('settings.mcp.openFile')}
                    >
                      <FolderOpen size={13} />
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-7" disabled={testing !== null} onClick={() => void test(entry)}>
                    <Plug size={13} />
                    {testing === entry.name ? t('settings.mcp.testing') : t('settings.mcp.test')}
                  </Button>
                </div>
                {result && (
                  <p className={`mt-1.5 text-xs ${result.ok ? 'text-emerald-500' : 'text-destructive'}`}>
                    {result.ok
                      ? t('settings.mcp.testOk', { count: result.tools.length, tools: result.tools.join(', ') })
                      : t('settings.mcp.testFail', { error: result.error ?? '' })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editing ? t('settings.mcp.editTitle', { name: editing }) : t('settings.mcp.addTitle')}
        footer={
          <>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void submitForm()} disabled={!form.name.trim() || (form.type === 'stdio' ? !form.command.trim() : !form.url.trim())}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('settings.mcp.name')}>
            <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} disabled={editing !== null} />
          </Field>
          <Field label={t('settings.mcp.type')}>
            <div className="flex gap-2">
              {(['stdio', 'http'] as const).map((ty) => (
                <Button key={ty} size="sm" variant={form.type === ty ? 'default' : 'outline'} onClick={() => setForm((f) => ({ ...f, type: ty }))}>
                  {ty}
                </Button>
              ))}
            </div>
          </Field>
          {form.type === 'stdio' ? (
            <>
              <Field label={t('settings.mcp.command')}>
                <TextInput value={form.command} onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))} placeholder="npx" />
              </Field>
              <Field label={t('settings.mcp.args')} hint={t('settings.mcp.argsHint')}>
                <textarea
                  className="h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\work'}
                />
              </Field>
              <Field label="Env" hint={t('settings.mcp.envHint')}>
                <textarea
                  className="h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={form.env}
                  onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                  placeholder={'API_KEY=xxx\nDEBUG=1'}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <TextInput value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://example.com/mcp" />
              </Field>
              <Field label={t('settings.mcp.headers')} hint={t('settings.mcp.headersHint')}>
                <textarea
                  className="h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={form.headers}
                  onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
                  placeholder={'Authorization: Bearer xxx'}
                />
              </Field>
            </>
          )}
        </div>
      </Dialog>
    </div>
  );
}
