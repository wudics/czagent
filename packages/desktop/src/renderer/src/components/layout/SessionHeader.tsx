import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { useSessionsStore } from '../../stores/sessions';
import { useSettingsStore } from '../../stores/settings';
import { Badge } from '../ui/badge';
import { Select } from '../ui/select';

/** 会话头部：标题（可重命名）+ 状态 + Agent 切换（唯一入口；运行/排队时禁用） */
export function SessionHeader() {
  const { t } = useTranslation();
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const agents = useSettingsStore((s) => s.settings.agents);
  const patch = useSessionsStore((s) => s.patch);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 切换会话时退出编辑态
  useEffect(() => {
    setEditing(false);
  }, [session?.id]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!session) return null;
  const busy = session.status === 'running' || session.status === 'queued';

  const startEdit = (): void => {
    if (busy) return;
    setDraft(session.title);
    setEditing(true);
  };

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === session.title) return;
    // patch({title}) 会将 title_source 锁定为 user（自动标题不再覆盖）
    void patch(session.id, { title: next });
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      {editing ? (
        <input
          ref={inputRef}
          className="h-7 w-56 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <div className="group/title flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-medium">{session.title}</span>
          <button
            type="button"
            aria-label={t('header.rename')}
            title={t('header.rename')}
            disabled={busy}
            onClick={startEdit}
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
          >
            <Pencil size={12} />
          </button>
        </div>
      )}
      {session.status === 'queued' && <Badge variant="warning" className="shrink-0">{t('sidebar.queued')}</Badge>}
      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{t('header.agent')}</span>
        <Select
          className="h-7 w-32"
          value={session.agentId}
          disabled={busy}
          onChange={(e) => void patch(session.id, { agentId: e.target.value })}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
