import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle } from 'lucide-react';
import { useSessionsStore } from '../../stores/sessions';
import { useQuestionsStore } from '../../stores/questions';
import { Button } from '../ui/button';

export function QuestionCard() {
  const { t } = useTranslation();
  const activeId = useSessionsStore((s) => s.activeId);
  const pending = useQuestionsStore((s) => s.pending);
  const mine = pending.filter((p) => p.sessionId === activeId);
  const item = mine[0];
  const [custom, setCustom] = useState('');

  if (!item) return null;
  const { request } = item;

  const answer = (text: string): void => {
    setCustom('');
    void useQuestionsStore.getState().answer(item, text);
  };

  return (
    <div className="absolute bottom-3 left-1/2 z-20 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2">
      <div className="rounded-lg border border-border bg-card p-3 shadow-lg">
        <div className="flex items-center gap-2 text-sm font-medium">
          <HelpCircle size={15} className="text-primary" />
          {t('chat.questionTitle')}
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{request.question}</p>
        {request.options && request.options.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {request.options.map((o) => (
              <Button key={o} variant="outline" size="sm" onClick={() => answer(o)}>
                {o}
              </Button>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <input
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={custom}
            placeholder={t('chat.questionInput')}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (custom.trim()) answer(custom);
              }
            }}
          />
          <Button size="sm" disabled={!custom.trim()} onClick={() => answer(custom)}>
            {t('common.save')}
          </Button>
        </div>
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => answer('')}>
            {t('chat.questionSkip')}
          </Button>
        </div>
      </div>
    </div>
  );
}
