import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Settings } from 'lucide-react';
import { useUIStore } from '../../stores/ui';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { ModelsTab } from './ModelsTab';
import { AgentsTab } from './AgentsTab';
import { PermissionsTab } from './PermissionsTab';
import { GeneralTab } from './GeneralTab';
import { McpTab } from './McpTab';
import { SkillsTab } from './SkillsTab';

type TabId = 'models' | 'agents' | 'permissions' | 'mcp' | 'skills' | 'general';

const TABS: { id: TabId; key: string }[] = [
  { id: 'models', key: 'models' },
  { id: 'agents', key: 'agents' },
  { id: 'permissions', key: 'permissions' },
  { id: 'mcp', key: 'mcp' },
  { id: 'skills', key: 'skills' },
  { id: 'general', key: 'general' },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const openChat = useUIStore((s) => s.openChat);
  const [tab, setTab] = useState<TabId>('models');

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-3">
          <Button variant="ghost" size="icon" onClick={openChat} aria-label={t('settings.back')}>
            <ArrowLeft size={16} />
          </Button>
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <Settings size={14} />
            {t('settings.title')}
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                tab === item.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {t(`settings.tabs.${item.key}`)}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          {tab === 'models' && <ModelsTab />}
          {tab === 'agents' && <AgentsTab />}
          {tab === 'permissions' && <PermissionsTab />}
          {tab === 'mcp' && <McpTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'general' && <GeneralTab />}
        </div>
      </main>
    </div>
  );
}
