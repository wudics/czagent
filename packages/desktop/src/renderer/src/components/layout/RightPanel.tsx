import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FoldVertical } from 'lucide-react';
import { useSessionsStore } from '../../stores/sessions';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import { useTodosStore } from '../../stores/todos';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { ModelName } from './ModelName';
import { cn } from '../../lib/utils';

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-[13px]">{children}</div>
    </div>
  );
}

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

type CompactNote = { kind: 'ok' | 'idle' | 'err'; text: string };

export function RightPanel() {
  const { t } = useTranslation();
  const activeId = useSessionsStore((s) => s.activeId);
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const agents = useSettingsStore((s) => s.settings.agents);
  const usage = useChatStore((s) => s.usage);
  const context = useChatStore((s) => s.context);
  const replying = useChatStore((s) => s.replying);
  // 压缩状态来自跨会话注册表（切换会话回来仍能看到"压缩中"）
  const compacting = useChatStore((s) => (activeId ? !!s.compactingBySession[activeId] : false));
  const compact = useChatStore((s) => s.compact);
  const todos = useTodosStore((s) => (activeId ? s.bySession[activeId] : undefined)) ?? [];

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [note, setNote] = useState<CompactNote | null>(null);
  const noteTimer = useRef<number | null>(null);

  // todo 面板折叠状态：清单更新时自动展开/收起（全部完成 → 收起），也可手动点击标题切换
  const [todoExpanded, setTodoExpanded] = useState(true);
  const prevTodosRef = useRef(todos);
  const allDone = todos.length > 0 && todos.every((x) => x.status === 'completed');
  useEffect(() => {
    if (todos === prevTodosRef.current) return;
    prevTodosRef.current = todos;
    setTodoExpanded(!allDone);
  }, [todos, allDone]);

  useEffect(() => {
    if (activeId) void useTodosStore.getState().load(activeId);
  }, [activeId]);

  useEffect(() => {
    return () => {
      if (noteTimer.current) window.clearTimeout(noteTimer.current);
    };
  }, []);

  // 切换会话时清掉上一次的压缩提示
  useEffect(() => {
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    setNote(null);
    setConfirmOpen(false);
  }, [activeId]);

  // 上下文占用：主进程权威口径（session.context 事件，含 system prompt/env/MCP 说明 + 模型窗口），
  // open 时 IPC 初始拉取，随请求构建/回复落库/手动压缩实时刷新
  const contextUsed = context?.used ?? null;
  const contextLimit = context?.limit ?? 0;
  const contextPct = contextUsed !== null && contextLimit > 0 ? Math.min(100, (contextUsed / contextLimit) * 100) : null;

  const showNote = (kind: CompactNote['kind'], text: string): void => {
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    setNote({ kind, text });
    noteTimer.current = window.setTimeout(() => setNote(null), 4000);
  };

  const runCompact = async (): Promise<void> => {
    setConfirmOpen(false);
    try {
      const ok = await compact();
      if (ok) showNote('ok', t('panel.compactDone'));
      else showNote('idle', t('panel.compactIdle'));
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      showNote('err', /运行|running|queued/i.test(msg) ? t('panel.compactBusySession') : `${t('panel.compactFailed')}: ${msg}`);
    }
  };

  if (!session) {
    return (
      <aside className="hidden w-72 shrink-0 border-l border-border p-4 text-sm text-muted-foreground lg:block">
        {t('panel.empty')}
      </aside>
    );
  }

  const totalTokens =
    usage !== null ? usage.inputTokens + usage.outputTokens : null;

  return (
    <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border p-4 lg:block">
      <h3 className="mb-3 text-sm font-semibold">{t('panel.info')}</h3>
      <div className="space-y-3">
        <InfoRow label={t('panel.mode')}>
          <Badge variant={session.mode === 'script' ? 'warning' : 'default'}>
            {t(`modes.${session.mode}`)}
          </Badge>
        </InfoRow>
        <InfoRow label={t('panel.agents')}>
          {/* agent 已删除时只剩 id；名称与 id 同时展示便于脚本 ctx.agent.run 按其一引用 */}
          <span className="break-all">
            {agents.find((a) => a.id === session.agentId)?.name ?? session.agentId}
            <span className="ml-1.5 text-[11px] text-muted-foreground">{session.agentId}</span>
          </span>
        </InfoRow>
        <InfoRow label={t('panel.model')}>
          <ModelName id={session.modelId} />
        </InfoRow>
        <InfoRow label={t('panel.thinking')}>{t(`thinkingModes.${session.thinkingMode}`)}</InfoRow>
        <InfoRow label={t('panel.cwd')}>
          <span
            role="button"
            tabIndex={0}
            className="inline-flex cursor-pointer break-all rounded bg-muted px-1.5 py-0.5 text-xs hover:text-foreground"
            onClick={() => void window.czagent?.openPath?.(session.cwd)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') void window.czagent?.openPath?.(session.cwd);
            }}
          >
            {session.cwd}
          </span>
        </InfoRow>
        <InfoRow label={t('panel.tokens')}>
          {usage ? (
            <div className="space-y-0.5 text-xs">
              <div>
                {t('panel.usageTotal')}: <span className="font-medium">{totalTokens}</span>
              </div>
              <div className="text-muted-foreground">
                输入 {usage.inputTokens} · 输出 {usage.outputTokens}
                {usage.reasoningTokens > 0 && ` · 思考 ${usage.reasoningTokens}`}
              </div>
              {usage.cost > 0 && (
                <div className="text-muted-foreground">
                  {t('panel.cost')}: ${usage.cost.toFixed(4)}
                </div>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </InfoRow>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <h3 className="mb-2 text-sm font-semibold">{t('panel.context')}</h3>
        {contextPct !== null ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className={cn('font-medium', contextPct >= 90 && 'text-red-500')}>
                {contextPct.toFixed(0)}%
              </span>
              <span className="text-muted-foreground">
                {t('panel.contextOf', { used: fmtTokens(contextUsed!), limit: fmtTokens(contextLimit) })}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full transition-all', contextPct >= 90 ? 'bg-red-500' : 'bg-emerald-500')}
                style={{ width: `${contextPct}%` }}
              />
            </div>
          </div>
        ) : contextUsed !== null ? (
          <p className="text-xs text-muted-foreground">
            {fmtTokens(contextUsed)} · {t('panel.contextUnknown')}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">—</p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full justify-start"
          disabled={compacting || replying}
          onClick={() => setConfirmOpen(true)}
        >
          <FoldVertical size={13} />
          {compacting ? t('panel.compactBusy') : t('panel.compact')}
        </Button>
        {note && (
          <p
            className={cn(
              'mt-2.5 break-all text-xs',
              note.kind === 'ok' && 'text-emerald-600',
              note.kind === 'err' && 'text-red-500',
              note.kind === 'idle' && 'text-muted-foreground',
            )}
          >
            {note.text}
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <div
          role="button"
          tabIndex={0}
          className="mb-2 flex cursor-pointer select-none items-center gap-2"
          onClick={() => setTodoExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setTodoExpanded((v) => !v);
          }}
        >
          <h3 className="text-sm font-semibold">{t('panel.todoTitle')}</h3>
          {todos.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {todos.filter((x) => x.status === 'completed').length}/{todos.length}
            </span>
          )}
        </div>
        {todos.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('panel.todoEmpty')}</p>
        ) : !todoExpanded ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setTodoExpanded(true)}
          >
            {allDone ? (
              <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
            ) : (
              <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />
            )}
            <span className="break-words">
              {allDone ? t('panel.todoAllDone') : t('panel.todoCollapsed', { done: todos.filter((x) => x.status === 'completed').length, total: todos.length })}
            </span>
          </button>
        ) : (
          <div className="space-y-1">
            {todos.map((item, i) => (
              <div key={i} className="flex items-start gap-2">
                {item.status === 'completed' ? (
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
                ) : (
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      item.status === 'in_progress' ? 'animate-pulse bg-sky-500' : 'bg-muted-foreground/40',
                    )}
                  />
                )}
                <span className={cn('min-w-0 break-words text-[13px]', item.status === 'completed' && 'text-muted-foreground')}>
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('panel.compactConfirmTitle')}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              {t('panel.compactCancel')}
            </Button>
            <Button size="sm" onClick={() => void runCompact()}>
              {t('panel.compactConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t('panel.compactConfirmDesc')}</p>
      </Dialog>
    </aside>
  );
}
