import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { Field, NumInput, Section } from './fields';

export function GeneralTab() {
  const { t } = useTranslation();
  const general = useSettingsStore((s) => s.settings.general);
  const updateGeneral = useSettingsStore((s) => s.updateGeneral);

  return (
    <div className="space-y-6">
      <Section title={t('settings.general.title')}>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.general.language')}>
            <Select value={general.language} onChange={(e) => void updateGeneral({ language: e.target.value as 'zh-CN' | 'en-US' })}>
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
            </Select>
          </Field>
          <Field label={t('settings.general.theme')}>
            <Select value={general.theme} onChange={(e) => void updateGeneral({ theme: e.target.value as 'light' | 'dark' | 'system' })}>
              <option value="light">{t('settings.general.themes.light')}</option>
              <option value="dark">{t('settings.general.themes.dark')}</option>
              <option value="system">{t('settings.general.themes.system')}</option>
            </Select>
          </Field>
          <Field label={t('settings.general.maxConcurrency')}>
            <NumInput
              min={1}
              max={32}
              value={general.maxConcurrency}
              onChange={(e) => void updateGeneral({ maxConcurrency: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Field>
          <Field label={t('settings.general.titleAutoRounds')} hint={t('settings.general.titleAutoRoundsHint')}>
            <NumInput
              min={0}
              max={10}
              value={general.titleAutoRounds ?? 1}
              onChange={(e) => void updateGeneral({ titleAutoRounds: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
          <Field label={t('settings.general.scriptTimeout')} hint={t('settings.general.scriptTimeoutHint')}>
            <NumInput
              min={0}
              step={1}
              value={general.scriptTimeoutMinutes ?? 0}
              onChange={(e) => void updateGeneral({ scriptTimeoutMinutes: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
          <Field label={t('settings.general.chatInitialMessages')} hint={t('settings.general.chatInitialMessagesHint')}>
            <NumInput
              min={5}
              max={50}
              step={1}
              value={general.chatInitialMessages ?? 10}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value) || 10);
                void updateGeneral({ chatInitialMessages: Math.min(50, Math.max(5, n)) });
              }}
            />
          </Field>
          <Field label={t('settings.general.chatPageMessages')} hint={t('settings.general.chatPageMessagesHint')}>
            <NumInput
              min={10}
              max={100}
              step={1}
              value={general.chatPageMessages ?? 20}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value) || 20);
                void updateGeneral({ chatPageMessages: Math.min(100, Math.max(10, n)) });
              }}
            />
          </Field>
        </div>
      </Section>

      <Section title={t('settings.general.compaction')}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">{t('settings.general.auto')}</span>
            <Switch checked={general.compaction.auto} onCheckedChange={(v) => void updateGeneral({ compaction: { ...general.compaction, auto: v } })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('settings.general.reservedTokens')}>
              <NumInput value={general.compaction.reservedTokens} onChange={(e) => void updateGeneral({ compaction: { ...general.compaction, reservedTokens: Number(e.target.value) || 0 } })} />
            </Field>
            <Field label={t('settings.general.preserveRatio')}>
              <NumInput
                step={0.05}
                min={0.05}
                max={0.9}
                value={general.compaction.preserveRatio}
                onChange={(e) => void updateGeneral({ compaction: { ...general.compaction, preserveRatio: Number(e.target.value) || 0.25 } })}
              />
            </Field>
          </div>
        </div>
      </Section>
    </div>
  );
}
