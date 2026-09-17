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
export function chatLoadConfig() {
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
  /** 循环级重试状态（session.retry 事件；新一轮流式输出/会话结束时清除） */
  retrying: { attempt: number; maxAttempts: number; delayMs: number; message: string } | null;
  usage: Usage | null;
  /** 上下文占用（主进程权威口径：max(请求估算, 上次真实 usage) + 模型窗口；session.context 事件实时推送） */
  context: SessionContext | null;
  /**
   * 压缩中的会话注册表（sessionId → 流式占位块消息 id）。
   * 跨会话存活：切换会话不影响追踪，切回时按 id 重建占位块继续流式显示。
   */
  compactingBySession: Record<string, string>;
  open(sessionId: string): Promise<void>;
  attachEvents(): void;
  loadMoreTop(): Promise<void>;
  /** 销毁最旧已加载消息，返回实删数；count 缺省 = 超限时删一页。调用方保证 count 不越过可视安全余量 */
  dropOldest(count?: number): number;
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
  retrying: null,
  usage: null,
  context: null,
  compactingBySession: {},

  reset() {
    // compactingBySession 是跨会话注册表，不随激活会话重置
    set({
      messages: [],
      droppedCount: 0,
      hasMoreTop: false,
      loadingTop: false,
      lastTopShift: 0,
      replying: false,
      retrying: null,
      usage: null,
      context: null,
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
    // 该会话压缩仍在进行（切走又切回）：按注册表 id 重建流式占位块，
    // 错过的 delta 携带全量累积文本，下一帧即追上。
    // 竞态防御：delta 可能先于本次加载到达（upsertPartIn 已建同 id 占位块），去重避免双份
    const compactingMessageId = get().compactingBySession[sessionId];
    if (compactingMessageId) {
      set((s) =>
        s.messages.some((m) => m.id === compactingMessageId)
          ? s
          : {
              messages: [
                ...s.messages,
                { id: compactingMessageId, sessionId, role: 'user', parts: [{ type: 'compaction', summary: '' }], createdAt: Date.now() },
              ],
            },
      );
    }
    // 悬空 modelId 自动修复（模型被删除/配置重置后的旧会话）：按解析回退链落库，
    // 使主循环直接解析成功；未配置任何模型时不动（显示层显示"未配置"）
    const st = useSettingsStore.getState();
    if (st.loaded && meta?.modelId) {
      const resolved = st.resolveChatModelId(meta.modelId);
      if (resolved && resolved !== meta.modelId) await useSessionsStore.getState().patch(sessionId, { modelId: resolved });
    }
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
      const added = page.messages.length;
      // 函数式更新：等待 IPC 期间可能发生过销毁（dropOldest），以最新状态为基准合并
      set((s) => ({
        messages: [...page.messages, ...s.messages],
        droppedCount: Math.max(0, s.droppedCount - added),
        hasMoreTop: page.hasMore,
        lastTopShift: Math.max(0, added - s.droppedCount),
      }));
    } finally {
      set({ loadingTop: false });
    }
  },

  dropOldest(count) {
    const { maxLoaded, keep } = chatLoadConfig();
    let dropped = 0;
    set((s) => {
      const excess = Math.max(0, s.messages.length - keep);
      const n = Math.min(count ?? (s.messages.length > maxLoaded ? chatLoadConfig().page : 0), excess);
      if (n <= 0) return s;
      dropped = n;
      return { messages: s.messages.slice(n), droppedCount: s.droppedCount + n };
    });
    return dropped;
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
    const { sessionId, replying, compactingBySession } = get();
    if (!sessionId || replying) return false;
    if (compactingBySession[sessionId]) return false;
    try {
      return await getProvider().compactSession(sessionId);
    } finally {
      // 状态复位由 session.compacting/compacted 事件驱动（跨会话存活），此处无需处理
    }
  },

  handleEvent(ev) {
    // ---- 跨会话压缩追踪：先于激活会话守卫更新（切换会话不丢状态、切回可恢复） ----
    if (ev.type === 'session.compacting') {
      // wasTracked = 失败路径判定：session.compacted（成功）会先删除 tracker，
      // 因此 inactive 事件到达时 tracker 仍指向该消息 ⇒ 占位块需要清理；
      // 成功路径 checkpoint 已按同 id 归位，绝不能再删（否则摘要条消失）
      const wasTracked = !!ev.messageId && get().compactingBySession[ev.sessionId] === ev.messageId;
      set((s) => {
        const map = { ...s.compactingBySession };
        if (ev.active && ev.messageId) map[ev.sessionId] = ev.messageId;
        else delete map[ev.sessionId];
        const cleanup =
          !ev.active && wasTracked && ev.sessionId === s.sessionId
            ? { messages: s.messages.filter((m) => m.id !== ev.messageId) }
            : undefined;
        return { compactingBySession: map, ...(cleanup ?? {}) };
      });
    } else if (ev.type === 'session.compacted') {
      set((s) => {
        if (!(ev.sessionId in s.compactingBySession)) return s;
        const map = { ...s.compactingBySession };
        delete map[ev.sessionId];
        return { compactingBySession: map };
      });
    }

    const s = get();
    if (ev.sessionId !== s.sessionId) return;
    switch (ev.type) {
      case 'message.part.delta':
      case 'message.part.done':
        set({
          messages: upsertPartIn(s.messages, ev.messageId, ev.partIndex, ev.part, ev.sessionId),
          // 重试等待中：新一轮的实际输出（非空文本/推理）到达 → 重试结束
          ...(s.retrying &&
          ((ev.part.type === 'text' && ev.part.text.length > 0) || (ev.part.type === 'reasoning' && ev.part.text.length > 0))
            ? { retrying: null }
            : {}),
        });
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
          retrying: null,
        });
        break;
      case 'session.status':
        // queued 同样视为"进行中"（输入禁用），状态展示由 sessions store 驱动
        set({
          replying: ev.status === 'running' || ev.status === 'queued',
          ...(ev.status === 'idle' ? { retrying: null } : {}),
        });
        break;
      case 'session.retry':
        set({ retrying: { attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, message: ev.message } });
        break;
      case 'session.compacted': {
        // 先按 id 移除流式占位块（同一消息），再按时间序插入 checkpoint：
        // 向上翻页后旧区消息仍在列表上方，不能直接 append 到尾部
        const cp = ev.message;
        const withoutPlaceholder = s.messages.filter((m) => m.id !== cp.id);
        const idx = withoutPlaceholder.findIndex((m) => m.createdAt > cp.createdAt);
        const next = [...withoutPlaceholder];
        if (idx === -1) next.push(cp);
        else next.splice(idx, 0, cp);
        set({ messages: next });
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
