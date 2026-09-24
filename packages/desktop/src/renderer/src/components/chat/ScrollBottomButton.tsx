import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function ScrollBottomButton({ onClick, count }: { onClick: () => void; count?: number }) {
  const { t } = useTranslation();
  const n = count ?? 0;
  const label = n > 0 ? t('chat.jumpToBottomCount', { n }) : t('chat.jumpToBottom');
  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-accent-foreground"
      aria-label={label}
    >
      <ArrowDown size={13} />
      {label}
    </button>
  );
}
