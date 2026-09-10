import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings';

/** 会话模型显示名：按解析回退链（会话 id → chat 绑定 → 第一个启用模型）取有效模型；未配置任何模型显示"未配置" */
export function ModelName({ id }: { id: string }) {
  const { t } = useTranslation();
  // 订阅 settings 本身（load 完成后引用变化会触发重渲染）；函数引用作 selector 不响应异步加载，启动时模型名会一直停留在"未配置"
  const chatSettings = useSettingsStore((s) => s.settings);
  const enabled = useMemo(() => chatSettings.chatModels.filter((m) => m.enabled), [chatSettings.chatModels]);
  const bound = chatSettings.bindings.find((b) => b.capability === 'chat')?.modelId;
  const resolved =
    (id && enabled.some((m) => m.id === id) && id) ||
    (bound && enabled.some((m) => m.id === bound) && bound) ||
    enabled[0]?.id ||
    '';
  const name = resolved
    ? (chatSettings.chatModels.find((m) => m.id === resolved) ?? chatSettings.multimodalModels.find((m) => m.id === resolved))
        ?.displayName
    : undefined;
  if (!resolved) return <span className="min-w-0 truncate">{t('settings.models.unbound')}</span>;
  return <span className="min-w-0 truncate">{name ?? resolved}</span>;
}
