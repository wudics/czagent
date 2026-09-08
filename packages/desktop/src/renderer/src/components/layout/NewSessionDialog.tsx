import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionMode, ThinkingMode } from '@czagent/core';
import { useSessionsStore } from '../../stores/sessions';
import { useSettingsStore } from '../../stores/settings';
import { MOCK_THINKING_MODES } from '../../mock/scenarios';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { Select } from '../ui/select';

export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const create = useSessionsStore((s) => s.create);
  const allModels = useSettingsStore((s) => s.settings.models);
  const agents = useSettingsStore((s) => s.settings.agents);
  const chatModels = useMemo(
    () => allModels.filter((m) => m.capability === 'chat' && m.enabled),
    [allModels],
  );
  const providers = useSettingsStore((s) => s.settings.providers);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<SessionMode>('chat');
  const [agentId, setAgentId] = useState<string>('build');
  const [modelId, setModelId] = useState<string>(chatModels[0]?.id ?? '');
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('on');
  const [cwd, setCwd] = useState('');

  const submit = async (): Promise<void> => {
    await create({
      title: title.trim() || undefined,
      mode,
      agentId,
      modelId: modelId || chatModels[0]?.id,
      thinkingMode,
      cwd,
    });
    onClose();
    setTitle('');
  };

  const providerName = (id: string): string => providers.find((p) => p.id === id)?.name ?? id;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('newSession.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('newSession.cancel')}
          </Button>
          <Button onClick={() => void submit()}>{t('newSession.create')}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">{t('newSession.name')}</span>
          <input
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={title}
            placeholder={t('newSession.namePlaceholder')}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t('newSession.mode')}</span>
            <Select value={mode} onChange={(e) => setMode(e.target.value as SessionMode)}>
              <option value="chat">{t('modes.chat')}</option>
              <option value="script">{t('modes.script')}</option>
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t('newSession.agent')}</span>
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t('newSession.thinking')}</span>
            <Select
              value={thinkingMode}
              onChange={(e) => setThinkingMode(e.target.value as ThinkingMode)}
            >
              {MOCK_THINKING_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {t(`thinkingModes.${m.id}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t('newSession.model')}</span>
            <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}（{providerName(m.provider)}）
                </option>
              ))}
            </Select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">{t('newSession.cwd')}</span>
          <input
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={cwd}
            placeholder={t('newSession.cwdPlaceholder')}
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}
