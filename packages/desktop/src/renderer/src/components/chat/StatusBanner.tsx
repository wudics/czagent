import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useSessionsStore } from '../../stores/sessions';
import { useChatStore } from '../../stores/chat';
import { cn } from '../../lib/utils';

/**
 * 会话状态条（聊天区底部浮动）：仅在有瞬态状态时出现。
 * - 循环级重试（session.retry）：显示原因与等待提示，新一轮流式输出后自动消失
 * - 自动压缩（session.compacting）：运行中压缩时给出"压缩中"反馈
 *   （压缩状态取自跨会话注册表；手动压缩的流式摘要直接显示在时间线占位块中）
 */
export function StatusBanner() {
  const { t } = useTranslation();
  const activeId = useSessionsStore((s) => s.activeId);
  const retrying = useChatStore((s) => s.retrying);
  const replying = useChatStore((s) => s.replying);
  const compacting = useChatStore((s) => (activeId ? !!s.compactingBySession[activeId] : false));

  const text = retrying
    ? t('chat.retrying', {
        attempt: retrying.attempt,
        max: retrying.maxAttempts,
        seconds: Math.max(1, Math.round(retrying.delayMs / 1000)),
        message: retrying.message,
      })
    : compacting && replying
      ? t('panel.compactBusy')
      : null;
  if (!text) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
      <div
        className={cn(
          'flex max-w-[36rem] items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs shadow-sm backdrop-blur',
          retrying ? 'text-amber-600' : 'text-muted-foreground',
        )}
      >
        <Loader2 size={12} className="shrink-0 animate-spin" />
        <span className="truncate" title={text}>
          {text}
        </span>
      </div>
    </div>
  );
}
