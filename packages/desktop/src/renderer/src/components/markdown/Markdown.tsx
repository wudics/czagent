import { useMarkdown, escapeHtmlText } from '../../markdown/useMarkdown';
import { cn } from '../../lib/utils';

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMarkdown(text);
  if (!text) return null;
  return (
    <div
      className={cn('markdown-body', className)}
      // html 已在 useMarkdown 内消毒；解析未就绪/失败时显示转义纯文本，杜绝原始 HTML 注入
      dangerouslySetInnerHTML={{ __html: html || escapeHtmlText(text) }}
    />
  );
}
