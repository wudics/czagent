import type {
  AgentProvider,
  Attachment,
  AttachmentUpload,
  ChatMessage,
  CreateSessionInput,
  MessagePage,
  PermissionDecision,
  PermissionRequest,
  SendMessageInput,
  SessionContext,
  SessionEvent,
  SessionMeta,
  SessionPatch,
  Settings,
  Usage,
} from '@czagent/core';
import { buildScenario, chunkText, historyAssistantParts, HISTORY_USER_PROMPTS, MOCK_CWD, MOCK_MODELS, partFromPhase, type StreamPhase } from './scenarios';
import { loadSettings, saveSettings } from './settingsStorage';
import { mergeSettings, usageTotal } from '@czagent/core';

let uid = 0;
function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${Date.now().toString(36)}-${uid}`;
}

const NOW = Date.now();

function seedMeta(partial: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    mode: 'chat',
    agentId: 'build',
    cwd: MOCK_CWD,
    modelId: 'deepseek-v4-pro',
    thinkingMode: 'on',
    status: 'idle',
    webAccess: true,
    title: '未命名会话',
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function historyUserMessage(i: number): ChatMessage {
  return {
    id: `m${i}`,
    sessionId: 's-long',
    role: 'user',
    parts: [{ type: 'text', text: HISTORY_USER_PROMPTS[i % HISTORY_USER_PROMPTS.length]! }],
    createdAt: NOW - (1200 - i) * 6_000,
  };
}

function historyAssistantMessage(i: number): ChatMessage {
  return {
    id: `m${i}`,
    sessionId: 's-long',
    role: 'assistant',
    parts: historyAssistantParts(i),
    createdAt: NOW - (1200 - i) * 6_000 + 3_000,
  };
}

/** 生成一对 user/assistant 消息（偶数索引为 user） */
function longMessage(i: number): ChatMessage {
  return i % 2 === 0 ? historyUserMessage(i) : historyAssistantMessage(i);
}

function seedShortMessages(): Map<string, ChatMessage[]> {
  const map = new Map<string, ChatMessage[]>();

  map.set('s-demo-plan', [
    {
      id: 'p1',
      sessionId: 's-demo-plan',
      role: 'user',
      parts: [{ type: 'text', text: '帮我规划一下这个桌面智能体的整体架构' }],
      createdAt: NOW - 8_000_000,
    },
    {
      id: 'p2',
      sessionId: 's-demo-plan',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '先梳理需求：核心是 agent loop + 多模型接入 + 工具链。' },
        { type: 'text', text: '建议采用三层架构：\n\n1. **协议层**：统一各家模型为 `LLMEvent` 事件流\n2. **会话层**：主循环 + 上下文压缩 + 多会话并发\n3. **渲染层**：虚拟滚动 + 流式渲染\n\n详见项目文档 `docs/dev/`。' },
      ],
      createdAt: NOW - 7_500_000,
    },
    {
      id: 'p3',
      sessionId: 's-demo-plan',
      role: 'user',
      parts: [{ type: 'text', text: '多会话并发的方案是什么？' }],
      createdAt: NOW - 2_000_000,
    },
    {
      id: 'p4',
      sessionId: 's-demo-plan',
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          tool: 'grep',
          callID: 'p-c1',
          input: { pattern: 'SessionManager', include: '*.ts' },
          state: 'completed',
          title: 'grep SessionManager',
        },
        { type: 'tool-result', callID: 'p-c1', output: 'agent-loop.md: SessionManager 每会话独立 loop', state: 'completed' },
        { type: 'text', text: '每个会话一个独立 agent loop（异步），主进程事件循环可支撑多个并发；并发上限默认 4，超出排队，事件按 sessionID 分流。' },
      ],
      createdAt: NOW - 1_800_000,
    },
  ]);

  map.set('s-demo-code', [
    {
      id: 'c1',
      sessionId: 's-demo-code',
      role: 'user',
      parts: [{ type: 'text', text: '重构一下 src/utils.ts 里的工具函数' }],
      createdAt: NOW - 5_000_000,
    },
    {
      id: 'c2',
      sessionId: 's-demo-code',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '先看一下当前实现，找出可复用的抽象。' },
        {
          type: 'tool-call',
          tool: 'read',
          callID: 'c-r1',
          input: { file: 'src/utils.ts' },
          state: 'completed',
          title: 'read src/utils.ts',
        },
        {
          type: 'tool-result',
          callID: 'c-r1',
          output: '// src/utils.ts\nexport function formatDate(d: Date) {\n  return d.toISOString().slice(0, 10)\n}',
          state: 'completed',
        },
        { type: 'text', text: '已读取文件。当前 `formatDate` 耦合了 UTC 语义，建议拆成 `toDateString` 与 `format` 两个函数，便于测试与复用。' },
      ],
      createdAt: NOW - 4_500_000,
    },
  ]);

  map.set('s-script', [
    {
      id: 'sc1',
      sessionId: 's-script',
      role: 'user',
      parts: [{ type: 'text', text: '（脚本编排模式）运行报告脚本' }],
      createdAt: NOW - 600_000,
    },
    {
      id: 'sc2',
      sessionId: 's-script',
      role: 'assistant',
      parts: [
        { type: 'compaction', summary: '脚本：生成目录统计报告。并行执行 glob 与 git log，然后汇总写入 report.md。' },
        { type: 'text', text: '脚本执行完成，报告已生成 `report.md`（共 3 个文件，5 次提交）。' },
      ],
      createdAt: NOW - 300_000,
    },
  ]);

  return map;
}

class Emitter {
  private listeners = new Set<(ev: SessionEvent) => void>();

  on(cb: (ev: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(ev: SessionEvent): void {
    for (const l of this.listeners) l(ev);
  }
}

function makeUsage(textLength: number): Usage {
  const output = Math.round(textLength * 0.35);
  const input = Math.round(textLength * 0.18);
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: (input * 0.00045 + output * 0.0009) / 1_000_000,
  };
}

export class MockProvider implements AgentProvider {
  private emitter = new Emitter();
  private sessions: SessionMeta[];
  private shortMessages = seedShortMessages();
  /** 每个会话在"懒加载生成"之外额外追加的消息（运行中产生） */
  private extras = new Map<string, ChatMessage[]>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  private aborts = new Map<string, AbortController>();
  /** 每个会话的实时 usage 累计（mock） */
  private usage = new Map<string, Usage>();
  /** 每个会话的上下文占用（mock：随回复增长、压缩后回落） */
  private contextUsed = new Map<string, number>();

  private static LONG_TOTAL = 1200;

  constructor() {
    this.sessions = [
      seedMeta({ id: 's-demo-plan', title: '项目规划讨论', status: 'idle', modelId: 'deepseek-v4-pro' }),
      seedMeta({ id: 's-demo-code', title: '代码重构演示', status: 'idle', modelId: 'siliconflow-deepseek-v4' }),
      seedMeta({ id: 's-long', title: '长历史会话（分页演示）', status: 'idle', thinkingMode: 'off' }),
      seedMeta({ id: 's-script', title: '脚本编排示例', mode: 'script', agentId: 'plan', modelId: 'agnes-2.5-flash' }),
    ];
  }

  onEvent(cb: (ev: SessionEvent) => void): () => void {
    return this.emitter.on(cb);
  }

  // ---- 会话 CRUD ----

  async listSessions(): Promise<SessionMeta[]> {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(input: CreateSessionInput): Promise<SessionMeta> {
    const settings = loadSettings();
    const defaultChat = settings.models.find((m) => m.capability === 'chat' && m.enabled)?.id ?? MOCK_MODELS[0]!.id;
    const meta = seedMeta({
      id: nextId('s'),
      title: input.title ?? '新会话',
      mode: input.mode ?? 'chat',
      agentId: input.agentId ?? 'build',
      cwd: input.cwd && input.cwd.trim() ? input.cwd : MOCK_CWD,
      modelId: input.modelId ?? defaultChat,
      thinkingMode: input.thinkingMode ?? 'on',
      titleSource: input.title ? 'user' : 'auto',
    });
    this.sessions.push(meta);
    this.shortMessages.set(meta.id, []);
    this.emitter.emit({ sessionId: meta.id, type: 'session.updated', meta });
    return meta;
  }

  async patchSession(id: string, patch: SessionPatch): Promise<SessionMeta> {
    const meta = this.sessions.find((s) => s.id === id);
    if (!meta) throw new Error(`session not found: ${id}`);
    Object.assign(meta, patch, { updatedAt: Date.now() });
    // 用户改标题 → 锁定（与真实 Provider 一致，自动标题不再覆盖）
    if (patch.title !== undefined) meta.titleSource = 'user';
    this.emitter.emit({ sessionId: id, type: 'session.updated', meta: { ...meta } });
    return { ...meta };
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.shortMessages.delete(id);
    this.extras.delete(id);
    this.contextUsed.delete(id);
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
  }

  // ---- 消息与分页 ----

  private baseCount(sessionId: string): number {
    if (sessionId === 's-long') return MockProvider.LONG_TOTAL;
    return this.shortMessages.get(sessionId)?.length ?? 0;
  }

  private baseMessage(sessionId: string, index: number): ChatMessage {
    if (sessionId === 's-long') return longMessage(index);
    return (this.shortMessages.get(sessionId) ?? [])[index]!;
  }

  private indexOf(sessionId: string, messageId: string): number {
    const extras = this.extras.get(sessionId) ?? [];
    const ei = extras.findIndex((m) => m.id === messageId);
    if (ei >= 0) return this.baseCount(sessionId) + ei;
    if (sessionId === 's-long') {
      const n = Number(messageId.slice(1));
      return Number.isNaN(n) ? -1 : n;
    }
    return this.shortMessages.get(sessionId)?.findIndex((m) => m.id === messageId) ?? -1;
  }

  async getMessages(sessionId: string, opts: { beforeId?: string; limit?: number }): Promise<MessagePage> {
    const limit = opts.limit ?? 50;
    const total = this.baseCount(sessionId) + (this.extras.get(sessionId)?.length ?? 0);
    let end = opts.beforeId ? this.indexOf(sessionId, opts.beforeId) : total;
    if (end < 0) end = total;
    const start = Math.max(0, end - limit);
    const messages: ChatMessage[] = [];
    for (let i = start; i < end; i++) {
      messages.push(
        i < this.baseCount(sessionId)
          ? this.baseMessage(sessionId, i)
          : (this.extras.get(sessionId) ?? [])[i - this.baseCount(sessionId)]!,
      );
    }
    return {
      messages,
      hasMore: start > 0,
      beforeId: messages[0]?.id,
    };
  }

  // ---- 发送 / 停止 / 权限 ----

  async sendMessage(sessionId: string, input: SendMessageInput): Promise<ChatMessage> {
    const session = this.sessions.find((s) => s.id === sessionId);
    // 防重入（与真实 Provider 一致）
    if (session && (session.status === 'running' || session.status === 'queued')) {
      throw new Error('会话正在运行或排队中，请等待完成或停止后再发送。');
    }
    const userMessage: ChatMessage = {
      id: nextId('u'),
      sessionId,
      role: 'user',
      parts: [
        { type: 'text', text: input.text },
        ...(input.attachmentIds?.length ? [{ type: 'file' as const, name: `附件-${input.attachmentIds[0]}`, kind: 'txt', path: '/tmp/xx.txt' }] : []),
      ],
      createdAt: Date.now(),
    };
    this.extras.get(sessionId)?.push(userMessage) ?? this.extras.set(sessionId, [userMessage]);
    this.patchMeta(sessionId, { updatedAt: Date.now() });
    this.setStatus(sessionId, 'running');
    if (session) this.startStream(sessionId, session.thinkingMode, input.text);
    return userMessage;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.aborts.get(sessionId)?.abort();
    this.aborts.delete(sessionId);
  }

  /** 模拟手动压缩：尾部保留最新消息，其余折叠为摘要 checkpoint（非破坏） */
  async compactSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (session.status !== 'idle') throw new Error('会话正在运行，无法压缩');
    const page = await this.getMessages(sessionId, { limit: 300 });
    if (page.messages.length < 8) return false;
    const last = page.messages[page.messages.length - 1]!;
    const checkpoint: ChatMessage = {
      id: nextId('u'),
      sessionId,
      role: 'user',
      parts: [
        {
          type: 'compaction',
          summary: `（演示）已将较早的 ${page.messages.length - 1} 条历史折叠为摘要：此前的讨论围绕「${session.title}」展开，关键结论、文件路径与未完成事项均已保留。`,
        },
      ],
      createdAt: Math.max(0, last.createdAt - 1),
    };
    const extras = this.extras.get(sessionId);
    if (extras && extras.length > 0) extras.splice(extras.length - 1, 0, checkpoint);
    else this.extras.set(sessionId, [checkpoint]);
    this.emitter.emit({ sessionId, type: 'session.compacted', message: checkpoint });
    // 模拟压缩后回落：尾部保留（~15k 上限）+ 摘要
    this.emitContext(sessionId, 12_000 + Math.round(Math.random() * 4_000));
    return true;
  }

  async resolvePermission(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.pendingPermissions.get(request.id)?.(decision);
    this.pendingPermissions.delete(request.id);
  }

  async getUsage(sessionId: string): Promise<Usage | null> {
    return this.usage.get(sessionId) ?? null;
  }

  async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    const meta = this.sessions.find((s) => s.id === sessionId);
    if (!meta) return null;
    return { used: this.contextUsed.get(sessionId) ?? 0, limit: this.contextLimitOf(meta.modelId) };
  }

  /** 模型上下文窗口（0 = 未知），按当前设置解析 */
  private contextLimitOf(modelId: string): number {
    return loadSettings().models.find((m) => m.id === modelId)?.contextLimit ?? 0;
  }

  /** 记录并推送上下文占用（回复完成 / 手动压缩后调用） */
  private emitContext(sessionId: string, used: number): void {
    const meta = this.sessions.find((s) => s.id === sessionId);
    this.contextUsed.set(sessionId, used);
    this.emitter.emit({ sessionId, type: 'session.context', used, limit: this.contextLimitOf(meta?.modelId ?? '') });
  }

  async uploadAttachment(sessionId: string, upload: AttachmentUpload): Promise<Attachment> {
    const ext = upload.name.split('.').pop()?.toLowerCase() ?? '';
    const kind = ['txt', 'md', 'markdown'].includes(ext)
      ? 'txt'
      : ext === 'docx'
        ? 'docx'
        : ext === 'xlsx'
          ? 'xlsx'
          : ext === 'pptx'
            ? 'pptx'
            : ext === 'pdf'
              ? 'pdf'
              : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)
                ? 'image'
                : 'other';
    return {
      id: nextId('att'),
      sessionId,
      name: upload.name,
      kind,
      size: upload.size,
      storedPath: '',
      inline: false,
      createdAt: Date.now(),
    };
  }

  async getSettings(): Promise<Settings> {
    return loadSettings();
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return saveSettings(mergeSettings(loadSettings(), patch));
  }

  // ---- 内部：流式 ----

  private patchMeta(id: string, patch: Partial<SessionMeta>): void {
    const meta = this.sessions.find((s) => s.id === id);
    if (meta) {
      Object.assign(meta, patch);
      this.emitter.emit({ sessionId: id, type: 'session.updated', meta: { ...meta } });
    }
  }

  private setStatus(id: string, status: SessionMeta['status']): void {
    const meta = this.sessions.find((s) => s.id === id);
    if (meta) {
      meta.status = status;
      this.emitter.emit({ sessionId: id, type: 'session.status', status });
    }
  }

  private async startStream(sessionId: string, thinkingMode: SessionMeta['thinkingMode'], input: string): Promise<void> {
    const scenario = buildScenario(input, thinkingMode);
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    const signal = controller.signal;

    const messageId = nextId('a');
    const createdAt = Date.now();
    const parts: ChatMessage['parts'] = [];

    const emitPart = (partIndex: number, part: ChatMessage['parts'][number], done = false): void => {
      this.emitter.emit({
        sessionId,
        type: done ? 'message.part.done' : 'message.part.delta',
        messageId,
        partIndex,
        part,
      });
    };

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });

    let partIndex = 0;
    let lastDecision: PermissionDecision | null = null;

    for (const phase of scenario.phases) {
      if (signal.aborted) break;

      if (phase.kind === 'permission') {
        const request: PermissionRequest = { id: nextId('perm'), ...phase.request };
        this.emitter.emit({ sessionId, type: 'permission.request', request });
        lastDecision = await new Promise<PermissionDecision>((resolve) => {
          this.pendingPermissions.set(request.id, resolve);
          signal.addEventListener('abort', () => resolve('deny'), { once: true });
        });
        continue;
      }

      if (phase.kind === 'error') {
        const part: ChatMessage['parts'][number] = { type: 'error', message: phase.message };
        parts.push(part);
        emitPart(partIndex, part, true);
        partIndex++;
        continue;
      }

      const mapped = partFromPhase(phase, partIndex);
      if (!mapped) continue;

      if (mapped.part.type === 'tool-call') {
        const callPart = mapped.part;
        parts.push(callPart);
        emitPart(partIndex, callPart);
        if (phase.kind === 'tool' && phase.delay) await sleep(phase.delay);

        // 工具结果
        const denied = lastDecision === 'deny';
        const resultPart: ChatMessage['parts'][number] =
          denied
            ? { type: 'tool-result', callID: callPart.callID, output: null, state: 'error', error: '用户拒绝了该操作' }
            : { type: 'tool-result', callID: callPart.callID, output: (phase as { output: unknown }).output, state: 'completed' };
        parts[partIndex] = { ...callPart, state: resultPart.state === 'completed' ? 'completed' : 'error' };
        emitPart(partIndex, parts[partIndex]!, true);
        partIndex++;
        parts.push(resultPart);
        emitPart(partIndex, resultPart, true);
        partIndex++;
        lastDecision = null;
        continue;
      }

      // reasoning / text 流式
      const fullText = (mapped.phase as { text: string }).text;
      const chunks = chunkText(fullText);
      let acc = '';
      const basePart = mapped.part as { type: 'text' | 'reasoning'; text: string };
      for (const ch of chunks) {
        if (signal.aborted) break;
        acc += ch;
        const part = { ...basePart, text: acc };
        parts[partIndex] = part;
        emitPart(partIndex, parts[partIndex]!);
        await sleep(10);
      }
      if (!signal.aborted) {
        const finalPart = { ...basePart, text: fullText };
        parts[partIndex] = finalPart;
        emitPart(partIndex, parts[partIndex]!, true);
      }
      partIndex++;
    }

    this.aborts.delete(sessionId);

    const message: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      parts,
      createdAt,
    };
    this.extras.get(sessionId)?.push(message) ?? this.extras.set(sessionId, [message]);

    const textLength = parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
    const usage = makeUsage(textLength);
    const prev = this.usage.get(sessionId);
    this.usage.set(sessionId, {
      inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
      reasoningTokens: (prev?.reasoningTokens ?? 0) + usage.reasoningTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: (prev?.cost ?? 0) + usage.cost,
    });

    this.emitter.emit({ sessionId, type: 'session.usage', usage: this.usage.get(sessionId)! });
    // 上下文仪表：累计用量折算 + system prompt 近似值（与真实实现的权威口径对齐）
    this.emitContext(sessionId, usageTotal(this.usage.get(sessionId)!) + 8_000);
    this.emitter.emit({ sessionId, type: 'message.complete', messageId, message });
    this.setStatus(sessionId, 'idle');
    this.maybeAutoTitle(sessionId, input);
  }

  /** 模拟标题生成（与真实行为对齐）：首轮回复后且标题未被用户编辑/自定义时生成 */
  private maybeAutoTitle(sessionId: string, userText: string): void {
    const meta = this.sessions.find((s) => s.id === sessionId);
    if (!meta || meta.titleSource !== 'auto' || meta.title !== '新会话') return;
    const title = `演示 · ${userText.slice(0, 10)}`.trim();
    this.patchMeta(sessionId, { title });
  }
}

export function createMockProvider(): MockProvider {
  return new MockProvider();
}
