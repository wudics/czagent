import { memo } from 'react';
import type { ChatMessage } from '@czagent/core';
import { useSessionsStore } from '../../stores/sessions';
import { cn } from '../../lib/utils';
import { MessagePartView } from './MessagePartView';

function AssistantAvatar() {
  return (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
      AI
    </div>
  );
}

function MessageItemInner({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  // 脚本会话：user 消息即脚本源码，按代码样式渲染（等宽，不跑 markdown）
  const isScript = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeId)?.mode === 'script');
  const isScriptUser = isUser && isScript;

  return (
    <div className={cn('flex gap-3 py-2', isUser && 'flex-row-reverse')}>
      {!isUser && <AssistantAvatar />}
      {isUser ? (
        <div className="min-w-0 max-w-[85%] space-y-2 rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {message.parts.map((p, i) => {
            if (p.type === 'image') {
              return (
                <img
                  key={i}
                  src={p.dataUrl}
                  alt={p.name ?? '附件'}
                  className="max-h-72 w-auto rounded-md object-contain"
                />
              );
            }
            if (p.type === 'text') {
              return (
                <div
                  key={i}
                  className={cn('whitespace-pre-wrap wrap-anywhere', isScriptUser && 'font-mono text-[12.5px] leading-relaxed')}
                >
                  {p.text}
                </div>
              );
            }
            if (p.type === 'file') {
              return (
                <div key={i} className="inline-flex items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1 text-xs">
                  <span>📎</span>
                  <span>{p.name}</span>
                  <span className="opacity-70">({p.kind})</span>
                </div>
              );
            }
            return null;
          })}
        </div>
      ) : (
        <div className="min-w-0 flex-1 space-y-2.5">
          {message.parts.map((p, i) => (p ? <MessagePartView key={i} part={p} /> : null))}
        </div>
      )}
    </div>
  );
}

/** 按 message 引用 memo：流式/数组变化时只重渲染变化的消息，避免超长消息反复渲染 */
export const MessageItem = memo(MessageItemInner);
