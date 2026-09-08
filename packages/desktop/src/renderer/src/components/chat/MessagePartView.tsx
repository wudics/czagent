import { useState } from 'react';
import { Sparkles, Wrench } from 'lucide-react';
import type { MessagePart } from '@czagent/core';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../markdown/Markdown';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';

/** 超长文本阈值：超过则不跑 markdown，改为有界高度的纯文本块（防超大 DOM 拖垮虚拟列表） */
const LONG_TEXT_THRESHOLD = 10_000;
/** 折叠预览长度：默认只渲染前 N 字符，点击展开再挂全量（减小初始 DOM） */
const COLLAPSED_PREVIEW_CHARS = 2_000;

function LongText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= COLLAPSED_PREVIEW_CHARS) {
    return (
      <pre
        className={cn(
          'max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[12px] leading-relaxed',
          className,
        )}
      >
        {text}
      </pre>
    );
  }
  if (!expanded) {
    return (
      <div className={cn('rounded-md bg-muted/40 p-2 text-[12px] leading-relaxed', className)}>
        <pre className="whitespace-pre-wrap">{text.slice(0, COLLAPSED_PREVIEW_CHARS)}</pre>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          …（共 {text.length} 字符，点击展开）
        </button>
      </div>
    );
  }
  return (
    <div className={cn('rounded-md bg-muted/40 p-2 text-[12px] leading-relaxed', className)}>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap">{text}</pre>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        收起
      </button>
    </div>
  );
}

function reasoningLabelText(kind: 'pending' | 'done'): string {
  return kind === 'pending' ? '思考中' : '思考';
}

export function ReasoningView({ text }: { text: string }) {
  const done = text.length > 0;
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles size={12} className={cn(done && 'text-primary')} />
        <span>{reasoningLabelText(done ? 'done' : 'pending')}</span>
        {!done && <span className="h-1 w-1 animate-pulse rounded-full bg-current" />}
      </div>
      <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground italic">
        {text}
      </div>
    </div>
  );
}

function ToolStatusBadge({ state }: { state: 'running' | 'completed' | 'error' }) {
  const { t } = useTranslation();
  if (state === 'running') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
        {t('chat.toolRunning')}
      </span>
    );
  }
  if (state === 'completed') return <Badge variant="success">{t('chat.toolCompleted')}</Badge>;
  return <Badge variant="destructive">{t('chat.toolError')}</Badge>;
}

export function ToolCallView({ part }: { part: Extract<MessagePart, { type: 'tool-call' }> }) {
  return (
    <div className="tool-card">
      <div className="flex items-center gap-2">
        <Wrench size={13} className="shrink-0 text-muted-foreground" />
        <span className="text-[13px] font-medium">{part.tool}</span>
        {part.title && <span className="truncate text-xs text-muted-foreground">{part.title}</span>}
        <span className="ml-auto">
          <ToolStatusBadge state={part.state} />
        </span>
      </div>
      <details className="group mt-1">
        <summary className="cursor-pointer list-none text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <span className="select-none">参数</span>
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/60 p-2 text-[11px] leading-relaxed">
          {JSON.stringify(part.input, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function ToolResultView({ part }: { part: Extract<MessagePart, { type: 'tool-result' }> }) {
  const isErr = part.state === 'error';
  const text =
    typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2);
  return (
    <div className={cn('tool-result', isErr && 'tool-result-error')}>
      {isErr && part.error && (
        <div className="mb-1 text-xs font-medium text-destructive">{part.error}</div>
      )}
      {typeof part.output === 'string' ? (
        part.output.length > LONG_TEXT_THRESHOLD ? (
          <LongText text={part.output} />
        ) : (
          <Markdown text={text} className="text-[13px]" />
        )
      ) : (
        <LongText text={text} />
      )}
    </div>
  );
}

export function CompactionView({ summary }: { summary: string }) {
  const { t } = useTranslation();
  return (
    <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium">历史已压缩 · 点击展开摘要</summary>
      <div className="mt-1 whitespace-pre-wrap leading-relaxed">{summary}</div>
    </details>
  );
}

export function MessagePartView({ part }: { part: MessagePart }) {
  switch (part.type) {
    case 'text':
      return part.text.length > LONG_TEXT_THRESHOLD ? (
        <LongText text={part.text} className="message-text" />
      ) : (
        <Markdown text={part.text} className="message-text" />
      );
    case 'reasoning':
      return <ReasoningView text={part.text} />;
    case 'image':
      // 助手消息流中的生成图片（富输出落库；用户附件图片在 MessageItem 内联渲染）
      return (
        <img
          src={part.dataUrl}
          alt={part.name ?? 'image'}
          loading="lazy"
          className="max-h-80 max-w-full rounded-md border border-border object-contain"
        />
      );
    case 'tool-call':
      return <ToolCallView part={part} />;
    case 'tool-result':
      return <ToolResultView part={part} />;
    case 'error':
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {part.message}
        </div>
      );
    case 'compaction':
      return <CompactionView summary={part.summary} />;
    case 'file':
      if (part.kind === 'video' || part.kind === 'audio') {
        // 生成的视频/音频内联播放（czagent-file:// 协议由主进程映射本地文件）；不可播放时回退文件 chip
        return (
          <div className="space-y-1">
            {part.kind === 'video' ? (
              <video
                controls
                preload="metadata"
                src={toLocalMediaUrl(part.path)}
                className="max-h-80 w-full rounded-md border border-border bg-black"
              />
            ) : (
              <audio controls preload="metadata" src={toLocalMediaUrl(part.path)} className="w-full max-w-md" />
            )}
            <FileChip part={part} />
          </div>
        );
      }
      return <FileChip part={part} />;
  }
}

/** 本地绝对路径 → czagent-file:// URL（主进程协议映射；逐段编码处理空格/中文/# 等） */
function toLocalMediaUrl(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/^\//, '');
  return `czagent-file:///${norm.split('/').map(encodeURIComponent).join('/')}`;
}

function FileChip({ part }: { part: Extract<MessagePart, { type: 'file' }> }) {
  return (
    <button
      type="button"
      title="在资源管理器中显示"
      onClick={() => void window.czagent?.showItemInFolder(part.path)}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs transition-colors hover:bg-muted"
    >
      <span>📎</span>
      <span className="font-medium">{part.name}</span>
      <span className="text-muted-foreground">({part.kind})</span>
    </button>
  );
}
