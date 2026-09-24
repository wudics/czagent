import { memo } from 'react';
import type { ChatMessage, MessagePart } from '@czagent/core';
import { useSessionsStore } from '../../stores/sessions';
import { useChatStore } from '../../stores/chat';
import { cn } from '../../lib/utils';
import { MessagePartView } from './MessagePartView';

type ResultPart = Extract<MessagePart, { type: 'tool-result' }>;

/** tool-call/result 合并渲染：result 配进所属调用卡展开区；同 callID 多结果取配对的最新；孤儿 result 独立兜底 */
function toRenderItems(parts: MessagePart[]): { part: MessagePart; result?: ResultPart }[] {
  const resultByCall = new Map<string, ResultPart>();
  parts.forEach((p) => {
    if (p.type === 'tool-result') resultByCall.set(p.callID, p);
  });
  const consumed = new Set<ResultPart>();
  parts.forEach((p) => {
    if (p.type === 'tool-call') {
      const r = resultByCall.get(p.callID);
      if (r) consumed.add(r);
    }
  });
  const items: { part: MessagePart; result?: ResultPart }[] = [];
  for (const p of parts) {
    if (p.type === 'tool-result' && consumed.has(p)) continue;
    items.push({ part: p, result: p.type === 'tool-call' ? resultByCall.get(p.callID) : undefined });
  }
  return items;
}

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
  // 该消息是否为"压缩进行中"的流式占位块/checkpoint（摘要自动展开显示）
  const compacting = useChatStore((s) => s.compactingBySession[message.sessionId] === message.id);

  // 压缩 checkpoint/流式占位块（仅含 compaction part，user 或 assistant 角色均可能——
  // 活跃 delta 先到时 upsertPartIn 建的是 assistant 占位）：不走气泡，统一全宽渲染折叠条
  if (message.parts.length > 0 && message.parts.every((p) => p.type === 'compaction')) {
    return (
      <div className="flex flex-col gap-2 py-2">
        {message.parts.map((p, i) => (p ? <MessagePartView key={i} part={p} compacting={compacting} /> : null))}
      </div>
    );
  }

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
          {toRenderItems(message.parts).map((it, i) =>
            it.part ? <MessagePartView key={i} part={it.part} result={it.result} compacting={compacting} /> : null,
          )}
        </div>
      )}
    </div>
  );
}

/** 按 message 引用 memo：流式/数组变化时只重渲染变化的消息，避免超长消息反复渲染 */
export const MessageItem = memo(MessageItemInner);
