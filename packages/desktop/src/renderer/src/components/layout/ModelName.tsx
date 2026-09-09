import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings';

/** 会话模型显示名：按解析回退链（会话 id → chat 绑定 → 第一个启用模型）取有效模型；未配置任何模型显示"未配置" */
export function ModelName({ id }: { id: string }) {
  const { t } = useTranslation();
  const resolveChatModelId = useSettingsStore((s) => s.resolveChatModelId);
  const modelById = useSettingsStore((s) => s.modelById);
  const resolved = resolveChatModelId(id);
  const name = resolved ? modelById(resolved)?.displayName : undefined;
  if (!resolved) return <span className="min-w-0 truncate">{t('settings.models.unbound')}</span>;
  return <span className="min-w-0 truncate">{name ?? resolved}</span>;
}
