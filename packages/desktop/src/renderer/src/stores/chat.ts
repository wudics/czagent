import { create } from 'zustand';
import {
  getProvider,
  type ChatMessage,
  type MessagePart,
  type SessionContext,
  type SessionEvent,
  type Usage,
} from '@czagent/core';
import { useSessionsStore } from './sessions';
import { useSettingsStore } from './settings';

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 聊天加载窗口参数：初始条数 / 翻页条数来自设置，
 * 内存窗口随页大小派生（上限 6 页、裁剪保留 5 页，并设下限防抖动）。
 */
function chatLoadConfig() {
  const g = useSettingsStore.getState().settings.general;
  const page = clampInt(g.chatPageMessages, 20, 10, 100);
  const initial = clampInt(g.chatInitialMessages, 10, 5, 50);
  return {
    initial,
    page,
    maxLoaded: Math.max(page * 6, 100),
    keep: Math.max(page * 5, 80),
  };
}

interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  droppedCount: number;
  hasMoreTop: boolean;
  loadingTop: boolean;
  /** 最近一次向上加载后，旧消息在概念列表中的位移（用于滚动锚定） */
  lastTopShift: number;
  replying: boolean;
  usage: Usage | null;
  /** 上下文占用（主进程权威口径：max(请求估算, 上次真实 usage) + 模型窗口；session.context 事件实时推送） */
  context: SessionContext | null;
  /** 手动压缩进行中（摘要为一次 LLM 调用，需数秒） */
  compacting: boolean;
  open(sessionId: string): Promise<void>;
  attachEvents(): void;
  loadMoreTop(): Promise<void>;
  dropOldest(): void;
  send(text: string, attachmentIds?: string[], opts?: { allowEmpty?: boolean }): Promise<void>;
  stop(): void;
  /** 手动压缩上下文；返回是否实际压缩（false=无可压缩内容），失败抛错 */
  compact(): Promise<boolean>;
  handleEvent(ev: SessionEvent): void;
  reset(): void;
}

function upsertPartIn(messages: ChatMessage[], messageId: string, partIndex: number, part: MessagePart, sessionId: string): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    const placeholder: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
    };
    return upsertPartIn([...messages, placeholder], messageId, partIndex, part, sessionId);
  }
  const next = [...messages];
  const msg = { ...next[idx]!, parts: [...next[idx]!.parts] };
  msg.parts[partIndex] = part;
  next[idx] = msg;
  return next;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionId: null,
  messages: [],
  droppedCount: 0,
  hasMoreTop: false,
  loadingTop: false,
  lastTopShift: 0,
  replying: false,
  usage: null,
  context: null,
  compacting: false,

  reset() {
    set({
      messages: [],
      droppedCount: 0,
      hasMoreTop: false,
      loadingTop: false,
      lastTopShift: 0,
      replying: false,
      usage: null,
      context: null,
      compacting: false,
    });
  },

  async open(sessionId) {
    get().reset();
    set({ sessionId });
    const page = await getProvider().getMessages(sessionId, { limit: chatLoadConfig().initial });
    const meta = useSessionsStore.getState().sessions.find((x) => x.id === sessionId);
    set({
      messages: page.messages,
      hasMoreTop: page.hasMore,
      replying: meta?.status === 'running' || meta?.status === 'queued',
    });
    const usage = await getProvider().getUsage(sessionId);
    let context: SessionContext | null = null;
    try {
      context = await getProvider().getSessionContext(sessionId);
    } catch {
      // 上下文拉取失败不影响会话打开（事件随后会补）
    }
    set({ usage, context });
  },

  attachEvents() {
    getProvider().onEvent((ev) => get().handleEvent(ev));
  },

  async loadMoreTop() {
    const { sessionId, loadingTop, messages, droppedCount, hasMoreTop } = get();
    if (!sessionId || loadingTop) return;
    const beforeId = messages[0]?.id;
    if (!hasMoreTop && droppedCount <= 0) return;
    set({ loadingTop: true });
    try {
      const page = await getProvider().getMessages(sessionId, { beforeId, limit: chatLoadConfig().page });
      const oldDropped = droppedCount;
      const added = page.messages.length;
      set({
        messages: [...page.messages, ...messages],
        droppedCount: Math.max(0, oldDropped - added),
        hasMoreTop: page.hasMore,
        lastTopShift: Math.max(0, added - oldDropped),
      });
    } finally {
      set({ loadingTop: false });
    }
  },

  dropOldest() {
    const { messages } = get();
    const { maxLoaded, keep } = chatLoadConfig();
    if (messages.length <= maxLoaded) return;
    const drop = messages.length - keep;
    if (drop <= 0) return;
    set((s) => ({
      messages: s.messages.slice(drop),
      droppedCount: s.droppedCount + drop,
    }));
  },

  async send(text, attachmentIds = [], opts) {
    const { sessionId, replying } = get();
    const allowEmpty = opts?.allowEmpty === true;
    if (!sessionId || replying) return;
    if (!allowEmpty && !text.trim()) return;
    try {
      const userMessage = await getProvider().sendMessage(sessionId, { text, attachmentIds });
      set((s) => ({
        messages: [...s.messages, userMessage],
        replying: true,
      }));
    } catch (e) {
      // 防重入：会话运行/排队中重复发送 → 提示而不中断输入
      console.warn(String((e as Error)?.message ?? e));
    }
  },

  async stop() {
    const { sessionId } = get();
    if (!sessionId) return;
    await getProvider().stopSession(sessionId);
    set({ replying: false });
  },

  async compact() {
    const { sessionId, compacting, replying } = get();
    if (!sessionId || compacting || replying) return false;
    set({ compacting: true });
    try {
      return await getProvider().compactSession(sessionId);
    } finally {
      // 正常由 session.compacted 事件先到，这里兜底复位（切换会话/失败场景）
      if (get().sessionId === sessionId) set({ compacting: false });
    }
  },

  handleEvent(ev) {
    const s = get();
    if (ev.sessionId !== s.sessionId) return;
    switch (ev.type) {
      case 'message.part.delta':
      case 'message.part.done':
        set({ messages: upsertPartIn(s.messages, ev.messageId, ev.partIndex, ev.part, ev.sessionId) });
        break;
      case 'message.complete':
        set({
          messages: (() => {
            const idx = s.messages.findIndex((m) => m.id === ev.messageId);
            if (idx === -1) return [...s.messages, ev.message];
            const next = [...s.messages];
            next[idx] = ev.message;
            return next;
          })(),
          replying: false,
        });
        break;
      case 'session.status':
        // queued 同样视为"进行中"（输入禁用），状态展示由 sessions store 驱动
        set({ replying: ev.status === 'running' || ev.status === 'queued' });
        break;
      case 'session.compacted': {
        // checkpoint 按时间序插入：向上翻页后旧区消息仍在列表上方，不能直接 append 到尾部
        const cp = ev.message;
        const idx = s.messages.findIndex((m) => m.createdAt > cp.createdAt);
        const next = [...s.messages];
        if (idx === -1) next.push(cp);
        else next.splice(idx, 0, cp);
        set({ messages: next, compacting: false });
        break;
      }
      case 'session.usage':
        set({ usage: ev.usage });
        break;
      case 'session.context':
        // 上下文仪表：主进程权威口径（下一次请求规模 + 模型窗口），随请求构建/回复落库/压缩实时刷新
        set({ context: { used: ev.used, limit: ev.limit } });
        break;
      default:
        break;
    }
  },
}));
