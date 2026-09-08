import { useMarkdown } from '../../markdown/useMarkdown';
import { cn } from '../../lib/utils';

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMarkdown(text);
  if (!text) return null;
  return (
    <div
      className={cn('markdown-body', className)}
      dangerouslySetInnerHTML={{ __html: html || text }}
    />
  );
}
