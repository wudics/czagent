import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, MessageSquare, Plus, Settings, TerminalSquare, Trash2, Undo2, X } from 'lucide-react';
import type { SessionMeta } from '@czagent/core';
import { useSessionsStore } from '../../stores/sessions';
import { usePermissionsStore } from '../../stores/permissions';
import { useUIStore } from '../../stores/ui';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { NewSessionDialog } from './NewSessionDialog';

function StatusDot({ status }: { status: SessionMeta['status'] }) {
  if (status === 'running') {
    return (
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
    );
  }
  if (status === 'queued') {
    return <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />;
  }
  return <span className="inline-flex h-2 w-2 rounded-full bg-border" />;
}

function SessionRow({ session, active }: { session: SessionMeta; active: boolean }) {
  const { t } = useTranslation();
  const select = useSessionsStore((s) => s.select);
  const remove = useSessionsStore((s) => s.remove);
  const hasPending = usePermissionsStore((s) => s.pending.some((p) => p.sessionId === session.id));
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        // 确认删除待定时：点击行其他区域仅取消确认（不切换会话）
        if (confirming) {
          setConfirming(false);
          return;
        }
        select(session.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (confirming) {
            setConfirming(false);
            return;
          }
          select(session.id);
        }
      }}
      className={cn(
        'group flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
      )}
    >
      <div className="mt-0.5 shrink-0">
        {session.mode === 'script' ? <TerminalSquare size={14} className="text-muted-foreground" /> : <MessageSquare size={14} className="text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{session.title}</span>
          {session.mode === 'script' && <Badge variant="outline">{t('modes.script')}</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <StatusDot status={session.status} />
          {session.status === 'running' && <span className="shrink-0 whitespace-nowrap">{t('sidebar.running')}</span>}
          {session.status === 'queued' && <span className="shrink-0 whitespace-nowrap">{t('sidebar.queued')}</span>}
          {hasPending && (
            <span className="shrink-0 whitespace-nowrap font-medium text-amber-500">{t('sidebar.pendingConfirm')}</span>
          )}
          <span className="min-w-0 truncate">{session.modelId}</span>
        </div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-1">
          <Button
            variant="destructive"
            size="icon"
            className="h-6 w-6"
            title={t('sidebar.confirmDelete')}
            aria-label={t('sidebar.confirmDelete')}
            onClick={(e) => {
              e.stopPropagation();
              void remove(session.id);
            }}
          >
            <X size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('sidebar.cancel')}
            aria-label={t('sidebar.cancel')}
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
            }}
          >
            <Undo2 size={12} />
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
        >
          <Trash2 size={13} />
        </Button>
      )}
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const [creating, setCreating] = useState(false);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Bot size={16} />
        </div>
        <span className="text-sm font-semibold">czagent</span>
        <span className="ml-auto">
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} />
            {t('sidebar.newSession')}
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">{t('sidebar.empty')}</div>
        ) : (
          <div className="space-y-0.5">
            {sessions.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === activeId} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <Button variant="ghost" className="w-full justify-start gap-2 text-muted-foreground" onClick={() => useUIStore.getState().openSettings()}>
          <Settings size={14} />
          {t('sidebar.settings')}
        </Button>
      </div>

      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
    </aside>
  );
}
