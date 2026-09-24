import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Sparkles, Wrench } from 'lucide-react';
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
        data-scrollable
        className={cn(
          'max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/40 p-2 text-[12px] leading-relaxed',
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
        <pre className="whitespace-pre-wrap wrap-anywhere">{text.slice(0, COLLAPSED_PREVIEW_CHARS)}</pre>
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
      <pre data-scrollable className="max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere">{text}</pre>
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

/**
 * 思考过程（对齐 opencode 时间线呈现）：流式期间自动展开实时滚动（有界高度防布局跳）；
 * 结束（time.end 落库）自动折叠为"思考 · Ns"一行；用户手动开合过则不再自动折叠。
 */
export function ReasoningView({ text, time }: { text: string; time?: { start: number; end?: number } }) {
  const { t } = useTranslation();
  const streaming = !time?.end;
  const [open, setOpen] = useState(streaming);
  const touched = useRef(false);
  useEffect(() => {
    if (!streaming && !touched.current) setOpen(false);
  }, [streaming]);
  const secs = time?.end && time.start ? Math.max(1, Math.round((time.end - time.start) / 1000)) : undefined;
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2">
      <button
        type="button"
        onClick={() => {
          touched.current = true;
          setOpen((o) => !o);
        }}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground"
      >
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        <Sparkles size={12} className={cn(!streaming && 'text-primary')} />
        <span>
          {streaming ? t('chat.reasoningLive') : t('chat.reasoningDone')}
          {!streaming && secs != null && ` · ${t('chat.reasoningSeconds', { n: secs })}`}
        </span>
        {streaming && <span className="h-1 w-1 animate-pulse rounded-full bg-current" />}
      </button>
      {open && (
        <div
          data-scrollable
          className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere text-[13px] leading-relaxed text-muted-foreground italic"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ToolStatusBadge({ state }: { state: 'pending' | 'running' | 'completed' | 'error' }) {
  const { t } = useTranslation();
  if (state === 'pending' || state === 'running') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
        {t(state === 'pending' ? 'chat.toolPending' : 'chat.toolRunning')}
      </span>
    );
  }
  if (state === 'completed') return <Badge variant="success">{t('chat.toolCompleted')}</Badge>;
  return <Badge variant="destructive">{t('chat.toolError')}</Badge>;
}

/** 折叠态标题副文本：title（长任务进度）优先，否则紧凑单行入参摘要 */
function briefArgs(input: unknown): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    return s.length > 90 ? s.slice(0, 90) + '…' : s;
  } catch {
    return '';
  }
}

/**
 * 工具卡片（对齐 opencode BasicTool）：call 与 result 合并为一张可折叠卡。
 * 执行中默认展开（参数/进度可见），完成/失败自动折叠成一行（用户手动开合过则尊重其选择）；
 * 历史消息挂载即完成态 → 默认折叠，减少长会话 DOM 与视觉噪音。
 */
export function ToolCallView({
  part,
  result,
}: {
  part: Extract<MessagePart, { type: 'tool-call' }>;
  result?: Extract<MessagePart, { type: 'tool-result' }>;
}) {
  const settled = part.state === 'completed' || part.state === 'error';
  const [open, setOpen] = useState(!settled);
  const touched = useRef(false);
  useEffect(() => {
    if (settled && !touched.current) setOpen(false);
  }, [settled]);
  const brief = part.title ?? briefArgs(part.input);
  return (
    <div className="tool-card">
      <button
        type="button"
        onClick={() => {
          touched.current = true;
          setOpen((o) => !o);
        }}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronRight size={12} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Wrench size={13} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[13px] font-medium">{part.tool}</span>
        {brief && <span className="truncate text-xs text-muted-foreground">{brief}</span>}
        <span className="ml-auto shrink-0">
          <ToolStatusBadge state={part.state} />
        </span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          <pre data-scrollable className="max-h-40 overflow-auto rounded bg-muted/60 p-2 text-[11px] leading-relaxed">
            {JSON.stringify(part.input, null, 2)}
          </pre>
          {result ? <ToolResultBody part={result} /> : null}
        </div>
      )}
    </div>
  );
}

/** 结果正文（并入工具卡展开区或孤儿结果独立渲染共用；data-scrollable 供滚轮意图豁免） */
function ToolResultBody({ part }: { part: Extract<MessagePart, { type: 'tool-result' }> }) {
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

/** 孤儿结果（未找到所属 call 的历史/异常数据）独立渲染兜底 */
export function ToolResultView({ part }: { part: Extract<MessagePart, { type: 'tool-result' }> }) {
  return <ToolResultBody part={part} />;
}

export function CompactionView({ summary, streaming }: { summary: string; streaming?: boolean }) {
  const { t } = useTranslation();
  // 流式占位阶段：摘要未到/为空 → 显示"正在生成摘要"spinner；摘要到达后自动展开实时显示
  if (!summary.trim()) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
        {t('chat.compactingSummary')}
      </div>
    );
  }
  // streaming 时强制展开（摘要边生成边可见）；完成后回落为默认折叠，用户可手动展开
  return (
    <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" open={streaming || undefined}>
      <summary className="cursor-pointer font-medium">历史已压缩 · 点击展开摘要</summary>
      <div className="mt-1 whitespace-pre-wrap wrap-anywhere leading-relaxed">{summary}</div>
    </details>
  );
}

export function MessagePartView({
  part,
  result,
  compacting,
}: {
  part: MessagePart;
  /** tool-call 对应的 tool-result（同卡合并渲染；缺省为孤儿/占位调用，单独渲染） */
  result?: Extract<MessagePart, { type: 'tool-result' }>;
  compacting?: boolean;
}) {
  switch (part.type) {
    case 'text':
      return part.text.length > LONG_TEXT_THRESHOLD ? (
        <LongText text={part.text} className="message-text" />
      ) : (
        <Markdown text={part.text} className="message-text" />
      );
    case 'reasoning':
      return <ReasoningView text={part.text} time={part.time} />;
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
      return <ToolCallView part={part} result={result} />;
    case 'tool-result':
      return <ToolResultView part={part} />;
    case 'error':
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {part.message}
        </div>
      );
    case 'compaction':
      return <CompactionView summary={part.summary} streaming={compacting} />;
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
