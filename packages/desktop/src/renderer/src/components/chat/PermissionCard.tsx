import { useTranslation } from 'react-i18next';
import { ShieldAlert, ClipboardList } from 'lucide-react';
import type { PermissionDecision } from '@czagent/core';
import { useSessionsStore } from '../../stores/sessions';
import { usePermissionsStore } from '../../stores/permissions';
import { Button } from '../ui/button';
import { Markdown } from '../markdown/Markdown';

/**
 * 会话内嵌权限卡片（每会话独立渲染，多会话并发互不覆盖）。
 * plan-exit 走同一管线，展示为"计划已就绪"确认卡（内嵌计划预览）。
 */
export function PermissionCard() {
  const { t } = useTranslation();
  const activeId = useSessionsStore((s) => s.activeId);
  const pending = usePermissionsStore((s) => s.pending);
  const mine = pending.filter((p) => p.sessionId === activeId);
  const item = mine[0];
  if (!item) return null;

  const { request } = item;
  const resolve = (decision: PermissionDecision): void => {
    void usePermissionsStore.getState().resolve(item, decision);
  };
  const planPreview =
    request.tool === 'plan-exit' && typeof request.args === 'object' && request.args !== null
      ? String((request.args as Record<string, unknown>).plan ?? '')
      : '';

  if (request.tool === 'plan-exit') {
    return (
      <div className="absolute bottom-3 left-1/2 z-10 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2">
        <div className="rounded-lg border border-border bg-card p-3 shadow-lg">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ClipboardList size={15} className="text-primary" />
            {t('chat.planReadyTitle')}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('chat.planReadyHint')}</p>
          {planPreview && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                {t('chat.planPreview')}
              </summary>
              <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2">
                <Markdown text={planPreview} className="text-[13px]" />
              </div>
            </details>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => resolve('deny')}>
              {t('chat.planLater')}
            </Button>
            <Button size="sm" onClick={() => resolve('allow')}>
              {t('chat.planSwitch')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute bottom-3 left-1/2 z-10 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2">
      <div className="rounded-lg border border-border bg-card p-3 shadow-lg">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldAlert size={15} className="text-amber-500" />
          {t('chat.permissionTitle')}
          <span>{request.tool}</span>
          {request.targetPath && (
            <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{request.targetPath}</code>
          )}
        </div>
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs leading-relaxed">
          {JSON.stringify(request.args, null, 2)}
        </pre>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => resolve('deny')}>
            {t('chat.deny')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => resolve('allowAlways')}>
            {t('chat.allowAlways')}
          </Button>
          <Button size="sm" onClick={() => resolve('allow')}>
            {t('chat.allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  );
}
