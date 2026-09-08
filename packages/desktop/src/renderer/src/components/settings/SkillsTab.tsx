import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, RefreshCw } from 'lucide-react';
import type { SkillMeta } from '@czagent/core';
import { useSettingsStore } from '../../stores/settings';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Section } from './fields';

function SourceBadge({ source }: { source: SkillMeta['source'] }) {
  const { t } = useTranslation();
  const cls =
    source === 'builtin'
      ? 'bg-amber-500/15 text-amber-500'
      : source === 'global'
        ? 'bg-sky-500/15 text-sky-500'
        : 'bg-violet-500/15 text-violet-500';
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {t(`settings.skills.source.${source}`)}
    </span>
  );
}

export function SkillsTab() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const disabled = useSettingsStore((s) => s.settings.general.disabledSkills ?? []);
  const updateGeneral = useSettingsStore((s) => s.updateGeneral);

  const reload = useCallback(async (): Promise<void> => {
    const list = await window.czagent?.listSkills?.();
    if (list) setSkills(list);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = (name: string, on: boolean): void => {
    const set = new Set(disabled);
    if (on) set.delete(name);
    else set.add(name);
    void updateGeneral({ disabledSkills: [...set] });
  };

  return (
    <div className="space-y-6">
      <Section
        title={t('settings.skills.title')}
        action={
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            <RefreshCw size={14} />
          </Button>
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.skills.hint')}</p>
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.skills.enabledHint')}</p>
        <div className="space-y-2">
          {skills.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.skills.empty')}</p>}
          {skills.map((s) => {
            const on = !disabled.includes(s.name);
            return (
              <div key={`${s.source}:${s.name}`} className="rounded-md border border-border p-2.5">
                <div className="flex items-center gap-2">
                  <Switch checked={on} onCheckedChange={(v) => toggle(s.name, v)} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
                  <SourceBadge source={s.source} />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void window.czagent?.openPath?.(s.dir)}
                    aria-label={t('settings.skills.openDir')}
                  >
                    <FolderOpen size={13} />
                  </Button>
                </div>
                {s.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">{s.dir}</p>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
