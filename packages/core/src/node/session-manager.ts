import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AgentDef,
  AgentProvider,
  Attachment,
  AttachmentUpload,
  ChatMessage,
  CreateSessionInput,
  MessagePart,
  MessagePage,
  ModelConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
  ProviderConfig,
  SendMessageInput,
  SessionEvent,
  SessionMeta,
  SessionPatch,
  Settings,
  TodoItem,
  Usage,
} from '../provider.js';
import type { ConfigStore } from '../config/file.js';
import type { Db } from '../storage/client.js';
import { streamChat } from '../llm/client.js';
import type { ChatStreamRequest, LLMChatMessage } from '../llm/types.js';
import { LLMError, friendlyLLMMessage } from '../llm/errors.js';
import { createGenericProfile, getBuiltinProfile } from '../llm/profile.js';
import { createDefaultRegistry, ToolRegistry, INTERNAL_TOOLS } from '../tools/index.js';
import type { ToolDef } from '../tools/types.js';
import { isRichToolOutput } from '../tools/rich-output.js';
import { scanSkills, skillEnabled } from '../skills/discovery.js';
import { effectiveToolLoaded } from '../tools/policy.js';
import { applyTodo, todoToText, TODO_HINT, type TodoInput } from '../tools/todo.js';
import { isMcpServerEnabled, loadMcpConfig, readMcpLayers, writeGlobalMcpConfig } from '../mcp/config.js';
import { McpRegistry } from '../mcp/registry.js';
import { runEntryChild } from '../script/child.js';
import type { ScriptAgentRunOptions } from '../script/types.js';
import { checkPermission, classifyBashCommand, extractTargetPath, pathInside, resolvePath } from '../permission/index.js';
import { patchFilePaths } from '../tools/patch.js';
import { attachmentKind, imageToDataUrl, parseAttachmentToText, textToMessagePart } from './attachments.js';
import { estimateRequestTokens, pruneHistory, selectTailStart, tailBudget, truncateToolOutput, usageTotal } from '../compaction.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

let uid = 0;
function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${Date.now().toString(36)}-${uid}`;
}

/** 剥掉 GLM 等模型 reasoning_content 自带的 <think>...</think> 标记 */
function stripThinkTags(text: string): string {
  return text.replace(/<\/?think\s*\/?>/gi, '');
}

/** 联网开关（I16）：webAccess=false 的会话禁用的工具（主循环与子代理共用） */
function webAccessDisabled(meta: SessionMeta | undefined): Set<string> {
  return meta?.webAccess === false ? new Set(['webfetch', 'websearch']) : new Set<string>();
}

export interface SessionManagerOptions {
  db: Db;
  config: ConfigStore;
  emit?: (ev: SessionEvent) => void;
  /** 可注入以替换协议引擎（测试用） */
  streamChatImpl?: typeof streamChat;
  /** 工具注册表（测试可注入空实现） */
  registry?: ToolRegistry;
  /** 附件 temp 根目录（会话子目录内落盘） */
  attachmentsDir?: string;
  /** 内置技能目录根（skill 发现最低优先层；缺省则只有 全局/工作区 两层） */
  builtinSkillsDir?: string;
  /** MCP 全局配置目录（默认 ~/.czagent；测试注入临时目录避免污染真实配置） */
  globalMcpDir?: string;
}

function toolResultContent(r: { state: string; output?: unknown; error?: string }): string {
  return r.state === 'error'
    ? `错误：${r.error ?? '未知错误'}`
    : typeof r.output === 'string'
      ? r.output
      : JSON.stringify(r.output ?? null);
}

function buildRequestMessages(
  history: ChatMessage[],
  agentSystemPrompt?: string,
  env?: string,
  includeImages = true,
): LLMChatMessage[] {
  const out: LLMChatMessage[] = [];
  const systemParts = [
    agentSystemPrompt,
    env ? `<env>\n${env}\n</env>` : '',
  ].filter((s) => s && s.trim());
  if (systemParts.length > 0) out.push({ role: 'system', content: systemParts.join('\n\n') });
  for (const m of history) {
    if (m.role === 'user') {
      // 压缩 checkpoint 消息 → system 摘要
      const compactionParts = m.parts.filter((p): p is Extract<MessagePart, { type: 'compaction' }> => p.type === 'compaction');
      if (compactionParts.length > 0) {
        out.push({
          role: 'system',
          content: `以下是此前的对话摘要，请在此上下文基础上继续：\n${compactionParts.map((p) => p.summary).join('\n')}`,
        });
        if (compactionParts.length === m.parts.length) continue;
      }
      const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const fileHints = m.parts
        .filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file')
        .map((p) => `\n<附件: ${p.name}（已存至 ${p.path}，可调用 read 工具读取该路径）>`);
      const imageParts = m.parts.filter((p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image');
      // 当前模型无视觉时：历史里的图片不发送，替换为一行说明（避免 400）
      let content = text || fileHints.join('') || null;
      if (!includeImages && imageParts.length > 0) {
        content = (content ? content + '\n' : '') + '<图片附件已省略：当前模型不支持图片>';
      }
      const images = includeImages ? imageParts.map((p) => ({ dataUrl: p.dataUrl })) : [];
      out.push({
        role: 'user',
        content,
        images: images.length > 0 ? images : undefined,
      });
      continue;
    }
    if (m.role !== 'assistant') continue;
    // 防御性：只发送非空工具名的 tool-call；每个 tool_call 必配一条 role:tool（无结果则合成）
    const callParts = m.parts.filter(
      (p): p is Extract<MessagePart, { type: 'tool-call' }> => p.type === 'tool-call' && p.tool.trim() !== '',
    );
    const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const reasoning = m.parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('\n');
    const toolCalls = callParts.map((p) => ({
      id: p.callID,
      name: p.tool,
      arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}),
    }));
    // 跳过"空 assistant"消息（无文本/无推理/无工具调用，如仅含 error part 的失败残留），避免 content/tool_calls 都为空导致 400
    if (!text && !reasoning && toolCalls.length === 0) continue;
    out.push({
      role: 'assistant',
      content: text || null,
      reasoning: reasoning || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    for (const cp of callParts) {
      const result = m.parts.find(
        (p): p is Extract<MessagePart, { type: 'tool-result' }> => p.type === 'tool-result' && p.callID === cp.callID,
      );
      out.push({
        role: 'tool',
        content: result ? truncateToolOutput(toolResultContent(result), cp.tool) : '（该工具调用未执行/已中断）',
        toolCallId: cp.callID,
      });
    }
  }
  return out;
}

/**
 * 真实 Provider（主进程）：会话/消息持久化到 sqlite，设置落 JSON 文件。
 * sendMessage 走多轮 agent loop：流式 → tool_calls 执行（含权限）→ 回填 → 直至结束。
 */
export class SessionManager implements AgentProvider {
  private readonly aborts = new Map<string, AbortController>();
  private readonly listeners = new Set<(ev: SessionEvent) => void>();
  private readonly pendingAsks = new Map<string, (d: PermissionDecision) => void>();
  /** 待用户回答的提问（question 工具）：id → 回答回调 */
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  /** 会话任务清单（todo 工具）：内存缓存 + sessions.todo 列持久化（I18），重启后面板可恢复 */
  private readonly todos = new Map<string, TodoItem[]>();
  /** 正在运行的 runLoop 数（并发槽位） */
  private activeLoops = 0;
  /** 等待槽位的会话队列（sessionId） */
  private readonly queue: string[] = [];
  /** MCP 客户端注册表（应用级缓存：懒连接/错误隔离） */
  private readonly mcp = new McpRegistry();

  constructor(private readonly opts: SessionManagerOptions) {
    if (opts.emit) this.listeners.add(opts.emit);
    // I14.1 启动回收：脚本子进程随应用退出而亡，DB 里的 running/queued 必须复位，
    // 否则重启后会话永久卡在"运行中"且被防重入拒绝（脚本超时默认不限更需此兜底）
    try {
      for (const s of this.opts.db.storage.listSessions()) {
        if (s.status !== 'idle') this.opts.db.storage.updateSessionStatus(s.id, 'idle');
      }
    } catch {
      // 存储不可用时交给 stopSession 安全网
    }
  }

  private emit(ev: SessionEvent): void {
    for (const cb of [...this.listeners]) cb(ev);
  }

  onEvent(cb: (ev: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---- 会话 CRUD ----

  async listSessions(): Promise<SessionMeta[]> {
    return this.opts.db.storage.listSessions();
  }

  async createSession(input: CreateSessionInput): Promise<SessionMeta> {
    const settings = await this.opts.config.read();
    const defaultChat =
      settings.models.find((m) => m.capability === 'chat' && m.enabled)?.id ?? '';
    // 默认工作目录：用户目录\czworkspace（不存在则自动创建）
    const cwd = input.cwd && input.cwd.trim() ? input.cwd.trim() : join(homedir(), 'czworkspace');
    try {
      await fs.mkdir(cwd, { recursive: true });
    } catch {
      // 目录创建失败不阻塞建会话（首次工具写入时再报错）
    }
    const meta: SessionMeta = {
      id: nextId('s'),
      title: input.title ?? '新会话',
      mode: input.mode ?? 'chat',
      agentId: input.agentId ?? 'build',
      cwd,
      modelId: input.modelId ?? defaultChat,
      thinkingMode: input.thinkingMode ?? 'on',
      status: 'idle',
      webAccess: true,
      titleSource: input.title ? 'user' : 'auto',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.opts.db.storage.insertSession(meta, input.title ? 'user' : 'auto');
    this.emit({ sessionId: meta.id, type: 'session.updated', meta: { ...meta } });
    return meta;
  }

  async patchSession(id: string, patch: SessionPatch): Promise<SessionMeta> {
    // 用户改标题 → 锁定（title_source=user），自动生成不再覆盖
    const meta = this.opts.db.storage.patchSession(id, patch, Date.now(), patch.title !== undefined ? 'user' : undefined);
    this.emit({ sessionId: id, type: 'session.updated', meta: { ...meta } });
    return meta;
  }

  async deleteSession(id: string): Promise<void> {
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    // 若在并发队列中等待，先出队（后续 pumpQueue 会跳过不存在的会话）
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.todos.delete(id);
    this.opts.db.storage.deleteSession(id);
    // 清理该会话的附件 temp 目录
    if (this.opts.attachmentsDir) {
      await fs.rm(join(this.opts.attachmentsDir, id), { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---- 附件 ----

  async uploadAttachment(sessionId: string, upload: AttachmentUpload): Promise<Attachment> {
    if (upload.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件过大（${(upload.size / 1024 / 1024).toFixed(1)}MB，上限 20MB）`);
    }
    const dir = join(this.opts.attachmentsDir ?? homedir(), sessionId);
    await fs.mkdir(dir, { recursive: true });
    const id = nextId('att');
    const safeName = basename(upload.name) || 'file';
    const storedPath = join(dir, `${id}-${safeName}`);
    await fs.writeFile(storedPath, Buffer.from(upload.dataBase64, 'base64'));
    const att: Attachment = {
      id,
      sessionId,
      name: safeName,
      kind: attachmentKind(safeName),
      size: upload.size,
      storedPath,
      inline: false,
      createdAt: Date.now(),
    };
    this.opts.db.storage.insertAttachment(att);
    return att;
  }

  /** 用配置的图像理解模型（binding.image-understanding）生成图片描述；未配置/失败返回 null */
  private async describeImage(sessionId: string, dataUrl: string): Promise<string | null> {
    try {
      const settings = await this.opts.config.read();
      const binding = settings.bindings.find((b) => b.capability === 'image-understanding');
      const model = binding ? settings.models.find((m) => m.id === binding.modelId) : undefined;
      const provider = model ? settings.providers.find((p) => p.id === model.provider) : undefined;
      if (!model || !provider || !provider.apiKey || model.vision === false) return null;

      const profile = getBuiltinProfile(provider.id) ?? createGenericProfile(provider.baseUrl);
      const request: ChatStreamRequest = {
        baseUrl: profile.baseUrl,
        apiKey: provider.apiKey,
        model: model.id,
        messages: [
          {
            role: 'user',
            content: '请用简洁的中文描述这张图片的关键内容（画面主体、场景、文字等）。',
            images: [{ dataUrl }],
          },
        ],
        thinking: 'off',
        maxTokens: 1024,
        signal: this.aborts.get(sessionId)?.signal,
        path: profile.path,
        headers: profile.headers,
        thinkingParams: profile.thinkingParams,
        reasoningField: profile.reasoningField,
        reasoningMessageField: profile.reasoningMessageField,
        reasoningPassthrough: profile.reasoningPassthrough,
        options: profile.options,
      };
      const stream = this.opts.streamChatImpl ? this.opts.streamChatImpl(request) : streamChat(request);
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'text-delta') text += ev.text;
      }
      const trimmed = text.trim();
      return trimmed ? `${trimmed}` : null;
    } catch {
      return null;
    }
  }

  // ---- 上下文压缩 ----

  /** contextLimit<=0（未知）或 auto=false → 返回 null（不自动压缩）；否则返回可用 token 预算 */
  private compactionUsable(model: ModelConfig, settings: Settings): number | null {
    const cl = model.contextLimit ?? 0;
    const c = settings.general?.compaction;
    if (cl <= 0 || !c?.auto) return null;
    const u = cl - c.reservedTokens;
    return u > 0 ? u : null;
  }

  /** 最后一个 compaction checkpoint 在消息数组中的下标；无则 -1 */
  private lastCompactionIndex(messages: ChatMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.parts.some((p) => p.type === 'compaction')) return i;
    }
    return -1;
  }

  /** 请求窗口：从最后一个 compaction checkpoint 起（含），无则全量；saturated=窗口被 300 条上限截断（更早历史未进入） */
  private historyWindow(sessionId: string): { messages: ChatMessage[]; saturated: boolean } {
    const page = this.opts.db.storage.pageMessages(sessionId, undefined, 300);
    const idx = this.lastCompactionIndex(page.messages);
    const messages = idx >= 0 ? page.messages.slice(idx) : page.messages;
    // 仅当"窗口内看不到 checkpoint 且页外还有更早消息"才算饱和——checkpoint 在页内时窗口必然完整
    return { messages, saturated: idx < 0 && page.hasMore };
  }

  /** 摘要压缩：old 区折叠为摘要并写 DB checkpoint（旧消息保留在 DB，仅请求窗口跳过）。溢出判定由 runLoop 完成。返回是否实际插入 checkpoint */
  private async maybeCompact(opts: {
    sessionId: string;
    settings: Settings;
    model: ModelConfig;
    provider: ProviderConfig;
    signal: AbortSignal;
    /** 已 prune 的请求窗口 */
    history: ChatMessage[];
    usable: number;
  }): Promise<boolean> {
    const { sessionId, settings, model, provider, signal, history, usable } = opts;
    // headIdx 跳过已有的摘要 checkpoint；其摘要文本并入新一次 summarize（避免二次压缩丢失旧摘要）
    const headIdx = this.lastCompactionIndex(history) === 0 ? 1 : 0;
    const previousSummary =
      headIdx === 1
        ? history[0]!
            .parts.filter((p): p is Extract<MessagePart, { type: 'compaction' }> => p.type === 'compaction')
            .map((p) => p.summary)
            .join('\n\n')
        : undefined;
    // 尾部保留按 token 预算（最新一条必留）
    const budget = tailBudget(usable, settings.general.compaction.preserveRatio);
    const tailStart = selectTailStart(history, headIdx, budget);
    const old = history.slice(headIdx, tailStart);
    if (old.length === 0) return false;
    const summary = await this.summarize(sessionId, model, provider, old, signal, previousSummary);
    if (!summary) return false;

    const keep = history.slice(tailStart);
    // checkpoint 落在 old 与 keep 之间（createdAt 取 keep 最旧一条 -1ms）
    const createdAt = keep.length > 0 ? keep[0]!.createdAt - 1 : Date.now();
    const checkpoint: ChatMessage = {
      id: nextId('u'),
      sessionId,
      role: 'user',
      parts: [{ type: 'compaction', summary }],
      createdAt,
    };
    this.opts.db.storage.insertMessage(checkpoint);
    // 推送 checkpoint：运行中的界面无需重开会话即可看到「历史已压缩」折叠条
    this.emit({ sessionId, type: 'session.compacted', message: checkpoint });
    return true;
  }

  /** 用会话模型把旧消息总结为一段文本；图片剥为占位（不依赖视觉、不发原图），previousSummary 并入合并 */
  private async summarize(
    sessionId: string,
    model: ModelConfig,
    provider: ProviderConfig,
    history: ChatMessage[],
    signal: AbortSignal,
    previousSummary?: string,
  ): Promise<string | null> {
    try {
      const profile = getBuiltinProfile(provider.id) ?? createGenericProfile(provider.baseUrl);
      const stripped = history.map((m) => ({
        ...m,
        parts: m.parts.flatMap((p) =>
          p.type === 'image' ? [{ type: 'text' as const, text: `[图片附件: ${p.name ?? '未命名'}]` }] : [p],
        ),
      }));
      const system =
        '请阅读下面的对话历史，用简洁的中文写一段总结。必须保留：已得出的结论、做出的决定、重要文件/附件的名称与路径、与图片相关的内容、尚未完成的事项。不要编造历史中未出现的信息。' +
        (previousSummary ? `\n\n此前已有一份摘要如下，请合并其内容并去重：\n${previousSummary}` : '');
      const request: ChatStreamRequest = {
        baseUrl: profile.baseUrl,
        apiKey: provider.apiKey,
        model: model.id,
        messages: [
          { role: 'system', content: system },
          ...buildRequestMessages(stripped, undefined, undefined, true),
        ],
        thinking: 'off',
        maxTokens: 2048,
        signal,
        path: profile.path,
        headers: profile.headers,
        thinkingParams: profile.thinkingParams,
        reasoningField: profile.reasoningField,
        reasoningMessageField: profile.reasoningMessageField,
        reasoningPassthrough: profile.reasoningPassthrough,
        options: profile.options,
      };
      const stream = this.opts.streamChatImpl ? this.opts.streamChatImpl(request) : streamChat(request);
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'text-delta') text += ev.text;
      }
      const trimmed = text.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  }

  // ---- 消息 ----

  async getMessages(sessionId: string, opts: { beforeId?: string; limit?: number }): Promise<MessagePage> {
    return this.opts.db.storage.pageMessages(sessionId, opts.beforeId, opts.limit ?? 50);
  }

  async sendMessage(sessionId: string, input: SendMessageInput): Promise<ChatMessage> {
    const session = this.opts.db.storage.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    // 防重入：同会话运行/排队时不接受新消息
    if (session.status === 'running' || session.status === 'queued') {
      throw new Error('会话正在运行或排队中，请等待完成或停止后再发送。');
    }

    const userMessageId = nextId('u');
    // 脚本会话（I14.1）：恒运行工作目录入口（输入文本不再作源码）；先探测校验，失败无副作用
    let scriptEntry: string | null = null;
    if (session.mode === 'script') {
      scriptEntry = await this.findEntryFile(session.cwd || homedir());
      if (!scriptEntry) {
        throw new Error(`未找到工作目录入口脚本（${session.cwd || homedir()}）：候选 czagent.ts / czagent.js / .czagent/run.ts / .czagent/run.js`);
      }
    }
    const parts: MessagePart[] = [{ type: 'text', text: scriptEntry ? `▶ 运行入口：${basename(scriptEntry)}` : input.text }];

    // 解析附件（混合策略：文本内联 / 大文件引用 / 图片压缩→视觉或图像理解）
    if (input.attachmentIds?.length) {
      const settings = await this.opts.config.read();
      const model = settings.models.find((m) => m.id === session.modelId);
      const vision = model?.vision !== false;
      for (const aid of input.attachmentIds) {
        const att = this.opts.db.storage.getAttachment(aid);
        if (!att) continue;
        try {
          if (att.kind === 'image') {
            const buffer = await fs.readFile(att.storedPath);
            const dataUrl = await imageToDataUrl(buffer);
            if (vision) {
              parts.push({ type: 'image', dataUrl, name: att.name });
              this.opts.db.storage.updateAttachmentInline(aid, true);
            } else {
              // 无视觉：尝试图像理解模型生成描述；失败则降级文件引用
              const desc = await this.describeImage(sessionId, dataUrl);
              if (desc) {
                parts.push({ type: 'text', text: `<附件图片: ${att.name}（图像理解）>\n${desc}` });
                this.opts.db.storage.updateAttachmentInline(aid, true);
              } else {
                parts.push({
                  type: 'text',
                  text: `<已上传附件: ${att.name}（当前模型不支持图片，已存至 ${att.storedPath}）>`,
                });
                parts.push({ type: 'file', name: att.name, kind: att.kind, path: att.storedPath });
              }
            }
          } else {
            const buffer = await fs.readFile(att.storedPath);
            const text = await parseAttachmentToText(att, buffer);
            const part = textToMessagePart(att, text);
            if (part.type === 'file') {
              parts.push({
                type: 'text',
                text: `<已上传附件: ${att.name}（内容较大，已存至 ${att.storedPath}，可调用 read 工具读取该路径）>`,
              });
              parts.push(part);
            } else {
              parts.push(part);
            }
            this.opts.db.storage.updateAttachmentInline(aid, part.type !== 'file');
          }
          this.opts.db.storage.updateAttachmentMessage(aid, userMessageId);
        } catch {
          parts.push({
            type: 'text',
            text: `<已上传附件: ${att.name}（无法内联，已存至 ${att.storedPath}，可调用 read 工具读取该路径）>`,
          });
          parts.push({ type: 'file', name: att.name, kind: att.kind, path: att.storedPath });
        }
      }
    }

    const userMessage: ChatMessage = {
      id: userMessageId,
      sessionId,
      role: 'user',
      parts,
      createdAt: Date.now(),
    };
    this.opts.db.storage.insertMessage(userMessage);
    this.opts.db.storage.patchSession(sessionId, {}, Date.now());
    // 并发上限：有空槽直接运行，否则置 queued 入队接力
    let maxConcurrency = 4;
    try {
      maxConcurrency = (await this.opts.config.read()).general.maxConcurrency || 4;
    } catch {
      // ignore
    }
    const metaNow = (): void => {
      this.emit({ sessionId, type: 'session.updated', meta: { ...this.opts.db.storage.getSession(sessionId)! } });
    };
    if (this.activeLoops >= maxConcurrency) {
      this.opts.db.storage.updateSessionStatus(sessionId, 'queued');
      this.emit({ sessionId, type: 'session.status', status: 'queued' });
      metaNow();
      this.queue.push(sessionId);
    } else {
      this.opts.db.storage.updateSessionStatus(sessionId, 'running');
      this.emit({ sessionId, type: 'session.status', status: 'running' });
      metaNow();
      // 脚本会话（I14.1）：恒运行工作目录入口子进程；聊天会话照常起循环
      void (
        session.mode === 'script' && scriptEntry
          ? this.startScriptFileLoop(sessionId, scriptEntry)
          : this.startLoop(sessionId)
      );
    }
    return userMessage;
  }

  async stopSession(sessionId: string): Promise<void> {
    // 排队中：直接出队并恢复 idle（无需 abort）
    const qi = this.queue.indexOf(sessionId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.opts.db.storage.updateSessionStatus(sessionId, 'idle');
      this.emit({ sessionId, type: 'session.status', status: 'idle' });
      this.emit({ sessionId, type: 'session.updated', meta: { ...this.opts.db.storage.getSession(sessionId)! } });
      return;
    }
    if (this.aborts.has(sessionId)) {
      this.aborts.get(sessionId)?.abort();
      this.aborts.delete(sessionId);
      return;
    }
    // 安全网：既不在运行也不在排队（任何原因卡在 running/queued）→ 强制回 idle
    const meta = this.opts.db.storage.getSession(sessionId);
    if (meta && meta.status !== 'idle') {
      this.opts.db.storage.updateSessionStatus(sessionId, 'idle');
      this.emit({ sessionId, type: 'session.status', status: 'idle' });
      this.emit({ sessionId, type: 'session.updated', meta: { ...this.opts.db.storage.getSession(sessionId)! } });
    }
  }

  /** 手动压缩上下文：立即把旧历史折叠为摘要 checkpoint（非破坏）。不受 auto 开关限制；返回是否实际压缩 */
  async compactSession(sessionId: string): Promise<boolean> {
    const storage = this.opts.db.storage;
    const session = storage.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    if (session.status !== 'idle') throw new Error('会话正在运行，无法压缩');
    const settings = await this.opts.config.read();
    const model = settings.models.find((m) => m.id === session.modelId);
    const provider = settings.providers.find((p) => p.id === model?.provider);
    if (!model || !provider) throw new Error('找不到会话对应的模型或供应商配置');
    const history = pruneHistory(this.historyWindow(sessionId).messages);
    // contextLimit 未知（<=0）或 auto 关闭时传极大预算：尾部预算钳到 15k + 条数上限 200，按此压缩
    const usable = this.compactionUsable(model, settings) ?? Number.MAX_SAFE_INTEGER;
    const controller = new AbortController();
    return this.maybeCompact({
      sessionId,
      settings,
      model,
      provider,
      signal: controller.signal,
      history,
      usable,
    });
  }

  /** 占用槽位运行 runLoop；结束时释放槽位并接力队列 */
  private async startLoop(sessionId: string): Promise<void> {
    this.activeLoops += 1;
    try {
      await this.runLoop(sessionId);
    } finally {
      this.activeLoops -= 1;
      void this.pumpQueue();
    }
  }

  /** 从队列按序补位（并行占满剩余槽位） */
  private async pumpQueue(): Promise<void> {
    let maxConcurrency = 4;
    try {
      maxConcurrency = (await this.opts.config.read()).general.maxConcurrency || 4;
    } catch {
      // ignore
    }
    while (this.activeLoops < maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const meta = this.opts.db.storage.getSession(next);
      if (!meta || meta.status !== 'queued') continue; // 已被停止/删除
      this.opts.db.storage.updateSessionStatus(next, 'running');
      this.emit({ sessionId: next, type: 'session.status', status: 'running' });
      this.emit({ sessionId: next, type: 'session.updated', meta: { ...this.opts.db.storage.getSession(next)! } });
      if (meta.mode === 'script') {
        // I14.1：脚本排队会话补位时重探入口；无入口回 idle（发送校验与排队之间文件可能被删）
        const entry = await this.findEntryFile(meta.cwd || homedir());
        if (!entry) {
          this.opts.db.storage.updateSessionStatus(next, 'idle');
          this.emit({ sessionId: next, type: 'session.status', status: 'idle' });
          this.emit({ sessionId: next, type: 'session.updated', meta: { ...this.opts.db.storage.getSession(next)! } });
          continue;
        }
        void this.startScriptFileLoop(next, entry);
      } else {
        void this.startLoop(next);
      }
    }
  }

  async resolvePermission(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.pendingAsks.get(request.id)?.(decision);
    this.pendingAsks.delete(request.id);
  }

  async getUsage(sessionId: string): Promise<Usage | null> {
    return this.opts.db.storage.getUsage(sessionId);
  }

  /** 关闭全部 MCP 连接（应用退出时调用） */
  async closeMcp(): Promise<void> {
    await this.mcp.close();
  }

  /**
   * agent 是否"跟随全局的全开"（用于 MCP 服务器并入策略）：
   * 遗留白名单（tools 非空）或含任何显式 load 覆盖 → 受限；否则视为全开。
   */
  private isAgentAllOpen(ag?: AgentDef): boolean {
    if (!ag) return true;
    if (ag.tools.length > 0) return false;
    const ov = ag.toolOverrides;
    if (!ov) return true;
    return !Object.values(ov).some((o) => typeof o.load === 'boolean');
  }

  /**
   * 计算该 agent 在该 cwd 下实际生效的 MCP 服务器名单（I13）：
   * 全开 agent → 全局 enabled（enabled!==false）且非 agent 'off'；agent 'on' 覆盖全局关。
   * 受限 agent → 仅 agent.mcp['on'] 的服务器（不点名即不带 MCP）。
   */
  private allowedMcpServers(cwd: string, ag?: AgentDef): string[] {
    let config: ReturnType<typeof loadMcpConfig>;
    try {
      config = loadMcpConfig(cwd, this.opts.globalMcpDir);
    } catch {
      return [];
    }
    const names = Object.keys(config);
    if (this.isAgentAllOpen(ag)) {
      return names.filter((n) => {
        const o = ag?.mcp?.[n];
        if (o === 'on') return true;
        if (o === 'off') return false;
        return isMcpServerEnabled(config[n]!);
      });
    }
    return names.filter((n) => ag?.mcp?.[n] === 'on');
  }

  /** 设置页 MCP Tab：读取两层配置（含来源） */
  async mcpGetLayers(cwd?: string): Promise<ReturnType<typeof readMcpLayers>> {
    return readMcpLayers(cwd || homedir(), this.opts.globalMcpDir);
  }

  /** 设置页 MCP Tab：保存全局层配置 */
  async mcpSaveGlobal(config: Record<string, unknown>): Promise<void> {
    writeGlobalMcpConfig(config as never, this.opts.globalMcpDir);
  }

  /** 设置页 MCP Tab：连接测试 */
  async mcpTest(cfg: unknown): Promise<{ ok: boolean; tools: string[]; error?: string }> {
    return this.mcp.testConnection(cfg as never);
  }

  /** 设置页技能 Tab：列出内置 + 全局技能 */
  async listSkills(cwd?: string): Promise<ReturnType<typeof scanSkills>> {
    return scanSkills(cwd || homedir(), this.opts.builtinSkillsDir);
  }

  // ---- 设置 ----

  async getSettings(): Promise<Settings> {
    return this.opts.config.read();
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.opts.config.update(patch);
  }

  // ---- 权限 ----

  private requestPermission(
    sessionId: string,
    cwd: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    const id = nextId('perm');
    const request: PermissionRequest = { id, tool, args, targetPath: extractTargetPath(cwd, tool, args) };
    return new Promise<PermissionDecision>((resolve) => {
      const onAbort = (): void => {
        this.pendingAsks.delete(id);
        resolve('deny');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingAsks.set(id, (d) => {
        signal.removeEventListener('abort', onAbort);
        resolve(d);
      });
      this.emit({ sessionId, type: 'permission.request', request });
    });
  }

  /** 用户对 question 提问作答（IPC → 界面） */
  async resolveQuestion(id: string, answer: string): Promise<void> {
    this.pendingQuestions.get(id)?.(answer);
    this.pendingQuestions.delete(id);
  }

  /** 模型向用户提问：emit session.question 并等待文本回答；stop/abort → '' */
  private askUser(sessionId: string, signal: AbortSignal, question: string, options?: string[]): Promise<string> {
    const id = nextId('q');
    return new Promise<string>((resolve) => {
      const onAbort = (): void => {
        this.pendingQuestions.delete(id);
        resolve('');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingQuestions.set(id, (answer) => {
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      });
      this.emit({ sessionId, type: 'session.question', request: { id, question, ...(options && options.length > 0 ? { options } : {}) } });
    });
  }

  /** 读会话任务清单（IPC / 面板）：内存优先，未命中（如刚重启）时从 DB 恢复并回填 */
  getSessionTodo(sessionId: string): TodoItem[] {
    const cached = this.todos.get(sessionId);
    if (cached) return cached;
    let restored: TodoItem[] = [];
    try {
      restored = this.opts.db.storage.getSessionTodo(sessionId);
    } catch {
      // 存储不可用时按空清单处理
    }
    this.todos.set(sessionId, restored);
    return restored;
  }

  /** 应用 todo 工具操作并广播变化；返回渲染文本 */
  private async updateSessionTodo(sessionId: string, input: TodoInput): Promise<string> {
    const current = this.todos.get(sessionId) ?? [];
    const next = applyTodo(current, input);
    this.todos.set(sessionId, next);
    try {
      this.opts.db.storage.updateSessionTodo(sessionId, next);
    } catch {
      // 落库失败不阻断工具返回（下次更新会重写）
    }
    this.emit({ sessionId, type: 'session.todo', todos: next });
    const text = todoToText(next);
    return input.todos !== undefined || input.statuses !== undefined ? `${text}\n${TODO_HINT}` : text;
  }

  private async resolveForTool(
    sessionId: string,
    cwd: string,
    tool: string,
    args: unknown,
    agent: AgentDef | undefined,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    // MCP 工具全部默认放行（用户决策：动态 id 无法预列规则；前缀短路）
    if (tool.startsWith('mcp_')) return 'allow';
    const argRec = (args ?? {}) as Record<string, unknown>;
    // bash：安全命令直接放行（shell 以会话 cwd 运行），危险命令走规则判定（默认 ask）
    if (tool === 'bash') {
      const command = typeof argRec.command === 'string' ? argRec.command : '';
      const { mode } = classifyBashCommand(command);
      if (mode === 'allow') return 'allow';
      return this.resolveByRules(sessionId, cwd, tool, argRec, agent, settings, signal);
    }
    // 写类工具：agent 显式规则优先；settings 规则 allow/deny 生效、ask 交给路径感知；
    // 路径感知：cwd 内放行，cwd 外询问（决策 13）
    if (tool === 'write' || tool === 'edit' || tool === 'patch') {
      return this.resolveWrite(sessionId, cwd, tool, argRec, agent, settings, signal);
    }
    return this.resolveByRules(sessionId, cwd, tool, argRec, agent, settings, signal);
  }

  private async resolveByRules(
    sessionId: string,
    cwd: string,
    tool: string,
    argRec: Record<string, unknown>,
    agent: AgentDef | undefined,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    const { mode } = checkPermission({ tool, args: argRec, cwd, agent, rules: settings.permissions.default });
    if (mode === 'allow') return 'allow';
    if (mode === 'deny') return 'deny';
    return this.requestPermission(sessionId, cwd, tool, argRec, signal);
  }

  private async resolveWrite(
    sessionId: string,
    cwd: string,
    tool: string,
    argRec: Record<string, unknown>,
    agent: AgentDef | undefined,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    const perm = checkPermission({ tool, args: argRec, cwd, agent, rules: settings.permissions.default });
    // 写类工具：仅 allow/deny 生效；ask（agent 显式 / 规则 / 默认）一律交给路径感知
    if (perm.mode === 'deny') return 'deny';
    if (perm.mode === 'allow') return 'allow';
    // 路径感知：目标全部在 cwd 内 → 直接放行（决策 13）；否则询问
    const paths =
      tool === 'patch'
        ? patchFilePaths(typeof argRec.patch === 'string' ? argRec.patch : '')
        : typeof argRec.file === 'string'
          ? [argRec.file]
          : [];
    if (paths.length > 0 && paths.every((p) => pathInside(cwd, resolvePath(cwd, p)))) {
      return 'allow';
    }
    return this.requestPermission(sessionId, cwd, tool, argRec, signal);
  }

  // ---- 脚本编排（I7）----

  /** 探测工作目录入口脚本：czagent.ts → czagent.js → .czagent/run.ts → .czagent/run.js（取先存在者） */
  async findEntryFile(cwd?: string): Promise<string | null> {
    const base = cwd || homedir();
    const candidates = ['czagent.ts', 'czagent.js', join('.czagent', 'run.ts'), join('.czagent', 'run.js')];
    for (const rel of candidates) {
      const p = join(base, rel);
      try {
        await fs.access(p);
        return p;
      } catch {
        // 下一个候选
      }
    }
    return null;
  }

  /** 占用槽位执行目录入口脚本（I14.1：node 子进程 + esbuild bundle 实时读盘）；错误统一由 runScriptSession 收进消息 */
  private async startScriptFileLoop(sessionId: string, entryPath: string): Promise<void> {
    this.activeLoops += 1;
    try {
      await this.runScriptSession(sessionId, entryPath);
    } finally {
      this.activeLoops -= 1;
      void this.pumpQueue();
    }
  }

  private async runScriptSession(sessionId: string, entryPath: string): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    const signal = controller.signal;
    const storage = this.opts.db.storage;
    const session = storage.getSession(sessionId);
    if (!session) {
      this.aborts.delete(sessionId);
      return;
    }

    let settings: Settings;
    try {
      settings = await this.opts.config.read();
    } catch {
      // 与 runLoop 相同：早退必须回 idle
      this.aborts.delete(sessionId);
      storage.updateSessionStatus(sessionId, 'idle');
      this.emit({ sessionId, type: 'session.status', status: 'idle' });
      this.emit({ sessionId, type: 'session.updated', meta: { ...storage.getSession(sessionId)! } });
      return;
    }
    const model = settings.models.find((m) => m.id === session.modelId);
    const provider = settings.providers.find((p) => p.id === model?.provider);

    const scriptMsgId = nextId('a');
    const createdAt = Date.now();
    const parts: MessagePart[] = [];
    storage.insertMessage({ id: scriptMsgId, sessionId, role: 'assistant', parts: [], createdAt });
    const append = (part: MessagePart): number => {
      const idx = parts.length;
      parts.push(part);
      this.emit({ sessionId, type: 'message.part.delta', messageId: scriptMsgId, partIndex: idx, part });
      storage.updateMessageParts(scriptMsgId, parts);
      return idx;
    };
    const update = (idx: number, part: MessagePart): void => {
      parts[idx] = part;
      this.emit({ sessionId, type: 'message.part.delta', messageId: scriptMsgId, partIndex: idx, part });
      storage.updateMessageParts(scriptMsgId, parts);
    };
    const finalize = async (): Promise<void> => {
      await this.finalizeMessage(sessionId, scriptMsgId, parts, createdAt, undefined);
    };

    if (!model || !provider || !provider.apiKey) {
      append({ type: 'error', message: '未找到该会话对应的模型/Provider 配置，或尚未填写 API Key。' });
      this.aborts.delete(sessionId);
      await finalize();
      return;
    }

    const registry = this.opts.registry ?? createDefaultRegistry();
    const agent = settings.agents.find((a) => a.id === session.agentId);
    const cwd = session.cwd || homedir();
    const envBlock = `当前系统平台：${process.platform} (${process.arch})\n会话工作目录：${cwd}\n当前日期：${new Date().toISOString().slice(0, 10)}`;
    try {
      // 日志流（子进程 ctx.log / console / 非协议 stdout 行 → 同一个流式 text part）
      let logBuffer = '';
      let logIdx = -1;
      const scriptLog = (line: string): void => {
        logBuffer += (logBuffer ? '\n' : '') + line;
        const part: MessagePart = { type: 'text', text: logBuffer };
        if (logIdx < 0) logIdx = append(part);
        else update(logIdx, part);
      };

      // MCP 工具定义（按 agent 生效名单；bridge 侧 toolId → def 覆盖，其余走 registry）
      const scriptMcpAllowed = this.allowedMcpServers(cwd, agent);
      const mcpScriptTools = scriptMcpAllowed.length > 0 ? await this.mcp.getTools(cwd, this.opts.globalMcpDir, scriptMcpAllowed) : [];
      const mcpDefById = new Map(mcpScriptTools.map((t) => [t.id, t]));

      const timeoutMinutes = settings.general.scriptTimeoutMinutes ?? 0;
      // I14.1：node 子进程运行入口脚本；ctx 全经 stdio 桥回主进程（权限/卡片/子代理/日志）
      const value = await runEntryChild({
        entryPath,
        cwd,
        runDir: join(this.opts.attachmentsDir ?? join(process.cwd(), 'czagent-temp'), sessionId, 'script-runs'),
        sessionMeta: { id: sessionId, cwd, model: session.modelId, mode: session.mode },
        settingsGeneral: settings.general,
        timeoutMs: timeoutMinutes > 0 ? Math.round(timeoutMinutes * 60_000) : 0,
        signal,
        handlers: {
          onTool: async (toolId, input, timeoutMs) => {
            if (INTERNAL_TOOLS.includes(toolId) || toolId === 'question' || toolId === 'task') {
              throw new Error(`${toolId} 不可由脚本调用（子任务请用 ctx.agent.run）`);
            }
            // 联网开关（I16）：脚本直调 webfetch/websearch 同样受会话开关约束
            if (webAccessDisabled(session).has(toolId)) {
              throw new Error(`本会话已关闭联网，无法调用 ${toolId}`);
            }
            const def = mcpDefById.get(toolId);
            return this.runScriptTool({ registry, toolId, ...(def ? { def } : {}), input, sessionId, cwd, settings, agent, signal, append, update, ...(timeoutMs ? { timeoutMs } : {}) });
          },
          onAgentRun: (prompt, agentOpts) =>
            this.runSubAgent({ sessionId, session, settings, registry, cwd, envBlock, signal, prompt, agentOpts, disabledTools: webAccessDisabled(session), append, update }),
          onLog: (line) => scriptLog(line),
          onAsk: (tool, args) => this.requestPermission(sessionId, cwd, tool, (args ?? {}) as Record<string, unknown>, signal),
        },
      });
      let resultText: string;
      try {
        resultText = JSON.stringify(value ?? null, null, 2) ?? 'null';
      } catch {
        resultText = String(value);
      }
      append({ type: 'text', text: `✅ 脚本执行完成\n返回值：${resultText}` });
      await finalize();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      append({ type: 'error', message: msg });
      await finalize();
    } finally {
      this.aborts.delete(sessionId);
    }
  }

  /** ctx.tools 单次工具调用：权限判定 → 执行 → 工具卡片（call+result）追加到脚本消息；
   *  timeoutMs > 0 时该次调用限时（超时中止工具执行并 reject，不影响脚本整体超时） */
  private async runScriptTool(opts: {
    registry: ToolRegistry;
    toolId: string;
    /** 工具定义覆盖（MCP 动态工具不在注册表内时传入） */
    def?: ToolDef;
    input: unknown;
    sessionId: string;
    cwd: string;
    settings: Settings;
    agent?: AgentDef;
    signal: AbortSignal;
    /** 单次调用超时毫秒（缺省/0 = 不限） */
    timeoutMs?: number;
    append: (part: MessagePart) => number;
    update: (idx: number, part: MessagePart) => void;
  }): Promise<unknown> {
    const { registry, toolId, input, sessionId, cwd, settings, agent, signal, timeoutMs, append, update, def: defOverride } = opts;
    const def = defOverride ?? registry.get(toolId);
    if (!def || INTERNAL_TOOLS.includes(toolId)) throw new Error(`未知或不可用的工具：${toolId}`);

    const callID = nextId('c');
    const callIdx = append({ type: 'tool-call', tool: toolId, callID, input, state: 'running' });
    const finishCall = (state: 'completed' | 'error'): void => {
      update(callIdx, { type: 'tool-call', tool: toolId, callID, input, state });
    };

    const decision = await this.resolveForTool(sessionId, cwd, toolId, input, agent, settings, signal);
    if (decision === 'deny') {
      finishCall('error');
      append({ type: 'tool-result', callID, output: null, state: 'error', error: '用户拒绝了该操作' });
      throw new Error(`用户拒绝了 ${toolId} 操作`);
    }
    // 单次调用限时：per-call AbortController 链到会话信号（会话停止/超时同样中止）
    const callCtrl = new AbortController();
    const onSessionAbort = (): void => callCtrl.abort();
    signal.addEventListener('abort', onSessionAbort, { once: true });
    let callTimer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs && timeoutMs > 0) {
      callTimer = setTimeout(() => callCtrl.abort(), timeoutMs);
      callTimer.unref?.();
    }
    try {
      const output = await def.execute(input as Record<string, unknown>, {
        sessionId,
        cwd,
        settings,
        signal: callCtrl.signal,
        tempDir: this.opts.attachmentsDir,
        builtinSkillsDir: this.opts.builtinSkillsDir,
        reportProgress: (text) => {
          update(callIdx, { type: 'tool-call', tool: toolId, callID, input, state: 'running', title: text });
        },
        setAgent: async () => {},
        ask: (req) => this.requestPermission(sessionId, cwd, req.tool, req.args as Record<string, unknown>, signal),
        askUser: (q) => this.askUser(sessionId, signal, q.question, q.options),
        todo: (input) => this.updateSessionTodo(sessionId, input),
      });
      finishCall('completed');
      if (isRichToolOutput(output)) {
        // 富输出：图片/文件追加为独立 part，tool-result 只收文本
        for (const img of output.images ?? []) {
          append({ type: 'image', dataUrl: img.dataUrl, name: img.name });
        }
        for (const f of output.files ?? []) {
          append({ type: 'file', name: f.name ?? basename(f.path), kind: f.kind ?? 'file', path: f.path });
        }
        append({ type: 'tool-result', callID, output: output.text, state: 'completed' });
        return output.text;
      }
      append({ type: 'tool-result', callID, output, state: 'completed' });
      return output;
    } catch (e) {
      const msg =
        callCtrl.signal.aborted && !signal.aborted && callTimer
          ? `工具调用超时（${Math.round(timeoutMs! / 1000)}s）：${toolId}`
          : String((e as Error)?.message ?? e);
      finishCall('error');
      append({ type: 'tool-result', callID, output: null, state: 'error', error: msg });
      throw new Error(msg);
    } finally {
      if (callTimer) clearTimeout(callTimer);
      signal.removeEventListener('abort', onSessionAbort);
    }
  }

  /** ctx.agent.run：隔离上下文的精简多轮 agent loop（内存 messages，不落库；工具卡片追加到脚本消息） */
  private async runSubAgent(opts: {
    sessionId: string;
    session: SessionMeta;
    settings: Settings;
    registry: ToolRegistry;
    cwd: string;
    envBlock: string;
    signal: AbortSignal;
    prompt: string;
    agentOpts?: ScriptAgentRunOptions;
    /** 联网开关（I16）：主会话 webAccess=false 时传 {'webfetch','websearch'}，子代理同步禁网 */
    disabledTools?: Set<string>;
    append: (part: MessagePart) => number;
    update: (idx: number, part: MessagePart) => void;
  }): Promise<string> {
    const { sessionId, session, settings, registry, cwd, envBlock, signal, prompt, agentOpts, disabledTools, append, update } = opts;
    const agentDef =
      settings.agents.find((a) => a.id === (agentOpts?.agent ?? 'build')) ??
      settings.agents.find((a) => a.id === 'build');
    // 工具绑定：agentOpts.tools 显式白名单；否则按 agent 矩阵 load 链；plan/plan-exit 子运行永远排除
    const rules = settings.permissions.default;
    // 子代理禁止再派生/问询：task 防嵌套、question 保持主会话专用
    const SUB_AGENT_HIDDEN = ['task', 'question'];
    // MCP 工具定义：默认按 agent 生效服务器名单；agentOpts.mcpServers 显式传入时取交集
    const mcpAllowedBase = this.allowedMcpServers(cwd, agentDef);
    const mcpAllowed = agentOpts?.mcpServers ? mcpAllowedBase.filter((n) => agentOpts.mcpServers!.includes(n)) : mcpAllowedBase;
    const mcpTools =
      mcpAllowed.length > 0
        ? (await this.mcp.getTools(cwd, this.opts.globalMcpDir, mcpAllowed)).filter((t) => !(disabledTools?.has(t.id) ?? false))
        : [];
    let resolved = registry
      .list()
      .filter(
        (t) =>
          !INTERNAL_TOOLS.includes(t.id) &&
          !SUB_AGENT_HIDDEN.includes(t.id) &&
          !(disabledTools?.has(t.id) ?? false) &&
          (agentOpts?.tools ? agentOpts.tools.includes(t.id) : effectiveToolLoaded(agentDef, rules, t.id)),
      );
    // MCP 并入：显式 mcpServers → 始终并入（tools 白名单仍可过滤，白名单中可直接写 mcp_* 工具 id）；
    // 未显式传入 → 维持旧行为（仅全开 agent 且未传 tools 白名单时并入）
    const mcpCandidates = agentOpts?.tools ? mcpTools.filter((t) => agentOpts.tools!.includes(t.id)) : mcpTools;
    if (agentOpts?.mcpServers) {
      resolved = resolved.concat(mcpCandidates);
    } else if (!agentOpts?.tools && this.isAgentAllOpen(agentDef)) {
      resolved = resolved.concat(mcpCandidates);
    }
    const model =
      (agentOpts?.model ? settings.models.find((m) => m.id === agentOpts.model) : undefined) ??
      settings.models.find((m) => m.id === session.modelId);
    const provider = settings.providers.find((p) => p.id === model?.provider);
    if (!model || !provider?.apiKey) throw new Error('子运行模型不可用或未配置 API Key');
    const profile = getBuiltinProfile(provider.id) ?? createGenericProfile(provider.baseUrl);
    // 步数：agentOpts.maxSteps 显式覆盖 > agent 定义 steps > 不限（与设置界面"留空=不限"一致）
    const maxSteps =
      agentOpts?.maxSteps && agentOpts.maxSteps > 0
        ? agentOpts.maxSteps
        : agentDef?.steps && agentDef.steps > 0
          ? agentDef.steps
          : Number.POSITIVE_INFINITY;
    const canTool = model.toolcall !== false;

    const promptMsg: ChatMessage = {
      id: 'sub-prompt',
      sessionId,
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
      createdAt: 0,
    };
    const messages = buildRequestMessages([promptMsg], agentDef?.systemPrompt, envBlock, model.vision !== false);

    let finalText = '';
    let streamAcc = '';
    let agentTextIdx = -1;
    let exhausted = true;

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) {
        exhausted = false;
        return finalText;
      }
      const request: ChatStreamRequest = {
        baseUrl: profile.baseUrl,
        apiKey: provider.apiKey,
        model: model.id,
        messages,
        thinking: session.thinkingMode,
        maxTokens: model.maxOutput > 0 ? model.maxOutput : undefined,
        signal,
        path: profile.path,
        headers: profile.headers,
        thinkingParams: profile.thinkingParams,
        reasoningField: profile.reasoningField,
        reasoningMessageField: profile.reasoningMessageField,
        reasoningPassthrough: profile.reasoningPassthrough,
        options: profile.options,
        tools: canTool && resolved.length > 0 ? registry.toOpenAI(resolved) : undefined,
      };

      streamAcc = '';
      const turnToolCalls: { callID: string; tool: string; input: unknown }[] = [];
      let turnFinish = '';
      let streamError: LLMError | undefined;
      const stream = this.opts.streamChatImpl ? this.opts.streamChatImpl(request) : streamChat(request);
      try {
        for await (const ev of stream) {
          if (ev.type === 'text-delta') {
            streamAcc += ev.text;
            const part: MessagePart = { type: 'text', text: `[agent] ${streamAcc}` };
            if (agentTextIdx < 0) agentTextIdx = append(part);
            else update(agentTextIdx, part);
          } else if (ev.type === 'tool-call') {
            turnToolCalls.push({ callID: ev.callID, tool: ev.tool, input: ev.input });
          } else if (ev.type === 'finish') {
            turnFinish = ev.finishReason;
            if (ev.usage) this.reportUsage(sessionId, model.id, ev.usage);
          } else if (ev.type === 'error') {
            streamError = ev.error;
          }
        }
      } catch (err) {
        streamError = err instanceof LLMError ? err : new LLMError('unknown', String((err as Error)?.message ?? err), {});
      }

      if (signal.aborted) {
        exhausted = false;
        return finalText || streamAcc;
      }
      if (streamError) {
        if (agentTextIdx >= 0) update(agentTextIdx, { type: 'text', text: `[agent] ${streamAcc}` });
        throw new Error(friendlyLLMMessage(streamError));
      }

      if (turnFinish === 'tool_calls' && turnToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: streamAcc || null,
          toolCalls: turnToolCalls.map((t) => ({
            id: t.callID,
            name: t.tool,
            arguments: typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? {}),
          })),
        });
        for (const tc of turnToolCalls) {
          // MCP 工具不在注册表：从本轮并入的 mcpTools 中查找（与主循环同口径）
          const def = registry.get(tc.tool) ?? (tc.tool.startsWith('mcp_') ? mcpTools.find((t) => t.id === tc.tool) : undefined);
          let resultContent: string;
          let ok = true;
          // 先挂 running 卡片：reportProgress 实时更新标题（长任务进度，如视频生成轮询）
          const callIdx = append({ type: 'tool-call', tool: tc.tool, callID: tc.callID, input: tc.input, state: 'running' });
          if (!def || INTERNAL_TOOLS.includes(tc.tool)) {
            resultContent = `未知工具：${tc.tool}`;
            ok = false;
          } else {
            const decision = await this.resolveForTool(sessionId, cwd, tc.tool, tc.input, agentDef, settings, signal);
            if (decision === 'deny') {
              resultContent = '用户拒绝了该操作';
              ok = false;
            } else {
              try {
                const out = await def.execute(tc.input as Record<string, unknown>, {
                  sessionId,
                  cwd,
                  settings,
                  signal,
                  tempDir: this.opts.attachmentsDir,
                  builtinSkillsDir: this.opts.builtinSkillsDir,
                  reportProgress: (text) => {
                    update(callIdx, { type: 'tool-call', tool: tc.tool, callID: tc.callID, input: tc.input, state: 'running', title: text });
                  },
                  setAgent: async () => {},
                  ask: (req) => this.requestPermission(sessionId, cwd, req.tool, req.args as Record<string, unknown>, signal),
                  askUser: (q) => this.askUser(sessionId, signal, q.question, q.options),
                  todo: (input) => this.updateSessionTodo(sessionId, input),
                });
                // 富输出（子 agent 场景）：取文本；image/file part 仅追加到主会话消息流（此处不落库）
                resultContent = isRichToolOutput(out) ? out.text : typeof out === 'string' ? out : JSON.stringify(out ?? null);
              } catch (e) {
                resultContent = `错误：${String((e as Error)?.message ?? e)}`;
                ok = false;
              }
            }
          }
          update(callIdx, {
            type: 'tool-call',
            tool: tc.tool,
            callID: tc.callID,
            input: tc.input,
            state: ok ? 'completed' : 'error',
          });
          append({ type: 'tool-result', callID: tc.callID, output: ok ? resultContent : null, state: ok ? 'completed' : 'error', error: ok ? undefined : resultContent });
          messages.push({ role: 'tool', content: resultContent, toolCallId: tc.callID });
        }
        continue;
      }

      // 非工具调用 → 模型给出最终回答
      finalText = streamAcc;
      exhausted = false;
      break;
    }

    if (agentTextIdx >= 0) update(agentTextIdx, { type: 'text', text: `[agent] ${finalText || streamAcc}` });
    if (exhausted) append({ type: 'text', text: '[agent] 子运行达到步数上限，已返回当前结果' });
    return finalText || streamAcc;
  }

  // ---- 多轮 agent loop ----

  private async runLoop(sessionId: string): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    const signal = controller.signal;
    const storage = this.opts.db.storage;
    const session = storage.getSession(sessionId);
    if (!session) {
      this.aborts.delete(sessionId);
      return;
    }

    const emitPart = (messageId: string, partIndex: number, part: MessagePart, done = false): void => {
      this.emit({
        sessionId,
        type: done ? 'message.part.done' : 'message.part.delta',
        messageId,
        partIndex,
        part,
      });
    };

    let finalized = false;
    const finishNow = async (messageId: string, parts: MessagePart[], createdAt: number, usage: Usage | undefined): Promise<void> => {
      if (finalized) return;
      finalized = true;
      await this.finalizeMessage(sessionId, messageId, parts, createdAt, usage);
    };

    // 中断时把仍处于 running 的 tool-call 补成 error 结果，保证当前消息与后续请求一致
    const completeInterruptedTools = (messageId: string, parts: MessagePart[]): void => {
      const running = parts.filter(
        (p): p is Extract<MessagePart, { type: 'tool-call' }> => p.type === 'tool-call' && p.state === 'running',
      );
      if (running.length === 0) return;
      for (const cp of running) {
        const callIdx = parts.findIndex((p) => p.type === 'tool-call' && p.callID === cp.callID);
        if (callIdx >= 0) {
          parts[callIdx] = { ...(parts[callIdx] as Extract<MessagePart, { type: 'tool-call' }>), state: 'error' };
          emitPart(messageId, callIdx, parts[callIdx]!, true);
        }
        const resultIdx = parts.length;
        parts[resultIdx] = { type: 'tool-result', callID: cp.callID, output: null, state: 'error', error: '工具调用中断' };
        emitPart(messageId, resultIdx, parts[resultIdx]!, true);
      }
      storage.updateMessageParts(messageId, parts);
    };

    const appendError = async (messageId: string, parts: MessagePart[], createdAt: number, message: string, usage?: Usage): Promise<void> => {
      const idx = parts.length;
      parts.push({ type: 'error', message });
      emitPart(messageId, idx, parts[idx]!, true);
      await finishNow(messageId, parts, createdAt, usage);
    };

    let settings: Settings;
    try {
      settings = await this.opts.config.read();
    } catch {
      // 早退必须回 idle，否则会话永久卡在"运行中"（且 abort 已删，停止也救不回）
      this.aborts.delete(sessionId);
      storage.updateSessionStatus(sessionId, 'idle');
      this.emit({ sessionId, type: 'session.status', status: 'idle' });
      this.emit({ sessionId, type: 'session.updated', meta: { ...storage.getSession(sessionId)! } });
      return;
    }
    const model = settings.models.find((m) => m.id === session.modelId);
    const provider = settings.providers.find((p) => p.id === model?.provider);
    const agent = settings.agents.find((a) => a.id === session.agentId);

    if (!model || !provider) {
      const id = nextId('a');
      await appendError(id, [], Date.now(), '未找到该会话对应的模型/Provider 配置。');
      this.aborts.delete(sessionId);
      return;
    }
    if (!provider.apiKey) {
      const id = nextId('a');
      await appendError(id, [], Date.now(), '尚未配置 API Key，请到「设置 → 模型」填写后再试。');
      this.aborts.delete(sessionId);
      return;
    }

    const registry = this.opts.registry ?? createDefaultRegistry();
    const disabled = new Set<string>();
    // 步数未设置（留空）= 不限步数（与设置界面"留空=不限"一致）；显式填写 >0 数字才生效
    const maxSteps = agent?.steps && agent.steps > 0 ? agent.steps : Number.POSITIVE_INFINITY;
    const cwd = session.cwd || homedir();
    let envBlock = `当前系统平台：${process.platform} (${process.arch})\n会话工作目录：${cwd}\n当前日期：${new Date().toISOString().slice(0, 10)}`;
    // 技能发现（每次 runLoop 扫描一次）：有技能则注入 <available_skills>，agent 按需用 skill 工具加载
    // I13.3：逐条(skillOverrides) + 全局禁用名单，取 load(s)
    try {
      const disabledSkills = settings.general.disabledSkills ?? [];
      const skills = (await scanSkills(cwd, this.opts.builtinSkillsDir)).filter((s) => skillEnabled(s.name, agent, disabledSkills));
      if (skills.length > 0) {
        envBlock +=
          '\n\n<available_skills>\n' +
          skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') +
          '\n</available_skills>\n当任务与上述技能描述匹配时，先用 skill 工具（{name}）加载其完整说明，再按说明行动。';
      }
    } catch {
      // 技能扫描失败不影响会话
    }

    let providerUsage: Usage | undefined;
    let lastAssistantId: string | null = null;
    let lastParts: MessagePart[] = [];
    // doom-loop：同工具同参连续 3 次 → 询问
    let lastCallSig = '';
    let doomCount = 0;
    // 步数耗尽标记：仅当显式设置了最大步数并跑满时为 true（留空=不限，永不触发）
    let stepsExhausted = false;

    try {
      let turn = 0;
      while (true) {
        turn += 1;
        if (turn > maxSteps) {
          stepsExhausted = true;
          break;
        }

        // agent/model 每轮按会话当前配置解析（plan-exit 切 agent、中途切模型/思考模式后下一轮立即生效）
        const current = storage.getSession(sessionId);
        const turnAgent =
          settings.agents.find((a) => a.id === current?.agentId) ??
          settings.agents.find((a) => a.id === session.agentId);
        // 联网开关（I16）：每轮按会话当前配置解析（运行中切换下一轮立即生效），并传递给 task 子代理
        const turnDisabled = webAccessDisabled(current ?? session);
        const baseTools = registry
          .list()
          .filter((t) => !turnDisabled.has(t.id) && !disabled.has(t.id) && effectiveToolLoaded(turnAgent, settings.permissions.default, t.id));
        const turnModel = settings.models.find((m) => m.id === current?.modelId) ?? model;
        const turnProvider = settings.providers.find((p) => p.id === turnModel.provider) ?? provider;
        const turnProfile = getBuiltinProfile(turnProvider.id) ?? createGenericProfile(turnProvider.baseUrl);
        const turnThinking = current?.thinkingMode ?? session.thinkingMode;
        // MCP 工具并入：按 agent 生效服务器名单（全开=全局 enabled 且非 off；受限=点名 on）
        let mcpTools: ToolDef[] = [];
        const allowedServers = this.allowedMcpServers(cwd, turnAgent);
        if (allowedServers.length > 0) {
          mcpTools = (await this.mcp.getTools(cwd, this.opts.globalMcpDir, allowedServers)).filter((t) => !disabled.has(t.id));
        }
        const tools = baseTools.concat(mcpTools);
        const mcpNote =
          mcpTools.length > 0
            ? '\n\n<mcp_instructions>\n' + mcpTools.map((t) => `- ${t.id}: ${t.description}`).join('\n') + '\n</mcp_instructions>'
            : '';
        const canTool = turnModel.toolcall !== false;
        // 上下文压缩：溢出检测（估算 ∨ 上次真实 usage）→ 摘要 checkpoint → 仍超限丢最旧重试 ≤1；
        // contextLimit<=0 / auto=false 时跳过；工具输出持续 prune（请求侧，DB 不动）
        const compactUsable = this.compactionUsable(turnModel, settings);
        // 上次请求的上下文规模：取最近一条带 tokens 的 assistant 消息（持久化，跨 sendMessage 有效）
        const lastUsageOf = (hs: ChatMessage[]): number => {
          for (let i = hs.length - 1; i >= 0; i--) {
            const m = hs[i]!;
            if (m.role === 'assistant' && m.tokens) return usageTotal(m.tokens);
          }
          return 0;
        };
        const window0 = this.historyWindow(sessionId);
        let history = pruneHistory(window0.messages);
        // 窗口饱和（>300 条且窗口内无可见 checkpoint）→ 即使 token 未超预算也强制压缩，避免历史被静默丢弃
        const saturationCompact = window0.saturated && settings.general.compaction.auto;
        let requestMessages = buildRequestMessages(history, turnAgent?.systemPrompt, envBlock + mcpNote, turnModel.vision !== false);
        let est = Math.max(estimateRequestTokens(requestMessages), lastUsageOf(history));
        if ((compactUsable !== null && est >= compactUsable) || saturationCompact) {
          // 饱和触发的压缩不依赖 token 预算：usable 传极大值（尾部预算钳到 15k + 条数上限 200）
          await this.maybeCompact({
            sessionId,
            settings,
            model: turnModel,
            provider: turnProvider,
            signal,
            history,
            usable: compactUsable ?? Number.MAX_SAFE_INTEGER,
          });
          history = pruneHistory(this.historyWindow(sessionId).messages);
          requestMessages = buildRequestMessages(history, turnAgent?.systemPrompt, envBlock + mcpNote, turnModel.vision !== false);
          est = Math.max(estimateRequestTokens(requestMessages), lastUsageOf(history));
          if (compactUsable !== null && est >= compactUsable) {
            const start = this.lastCompactionIndex(history) === 0 ? 1 : 0;
            if (start < history.length) {
              // 丢弃最旧一条非 checkpoint 消息（保留摘要 checkpoint），仅重试一次
              history = pruneHistory(history.slice(0, start).concat(history.slice(start + 1)));
              requestMessages = buildRequestMessages(history, turnAgent?.systemPrompt, envBlock + mcpNote, turnModel.vision !== false);
            }
          }
        }
        const request: ChatStreamRequest = {
          baseUrl: turnProfile.baseUrl,
          apiKey: turnProvider.apiKey,
          model: turnModel.id,
          messages: requestMessages,
          thinking: turnThinking,
          maxTokens: turnModel.maxOutput > 0 ? turnModel.maxOutput : undefined,
          signal,
          path: turnProfile.path,
          headers: turnProfile.headers,
          thinkingParams: turnProfile.thinkingParams,
          reasoningField: turnProfile.reasoningField,
          reasoningMessageField: turnProfile.reasoningMessageField,
          reasoningPassthrough: turnProfile.reasoningPassthrough,
          options: turnProfile.options,
          tools: canTool && tools.length > 0 ? registry.toOpenAI(tools) : undefined,
        };

        const assistantId = nextId('a');
        const createdAt = Date.now();
        const parts: MessagePart[] = [];
        storage.insertMessage({ id: assistantId, sessionId, role: 'assistant', parts: [], createdAt });
        lastAssistantId = assistantId;
        lastParts = parts;

        let reasoningAcc = '';
        let textAcc = '';
        const turnToolCalls: { callID: string; tool: string; input: unknown }[] = [];
        let turnFinish: string | undefined;
        let streamError: LLMError | undefined;

        const stream = this.opts.streamChatImpl ? this.opts.streamChatImpl(request) : streamChat(request);
        try {
          for await (const ev of stream) {
            switch (ev.type) {
              case 'reasoning-delta': {
                reasoningAcc += stripThinkTags(ev.text);
                parts[0] = { type: 'reasoning', text: reasoningAcc };
                emitPart(assistantId, 0, parts[0]!);
                storage.updateMessageParts(assistantId, parts);
                break;
              }
              case 'text-delta': {
                textAcc += ev.text;
                const idx = reasoningAcc ? 1 : 0;
                parts[idx] = { type: 'text', text: textAcc };
                emitPart(assistantId, idx, parts[idx]!);
                storage.updateMessageParts(assistantId, parts);
                break;
              }
              case 'tool-call': {
                turnToolCalls.push({ callID: ev.callID, tool: ev.tool, input: ev.input });
                const idx = parts.length;
                parts[idx] = { type: 'tool-call', tool: ev.tool, callID: ev.callID, input: ev.input, state: 'running' };
                emitPart(assistantId, idx, parts[idx]!);
                storage.updateMessageParts(assistantId, parts);
                break;
              }
              case 'finish':
                turnFinish = ev.finishReason;
                if (ev.usage) {
                  providerUsage = ev.usage;
                  // 逐轮落库+广播：Token 统计/占用条随每次 LLM 请求实时刷新，不再等整轮结束
                  this.reportUsage(sessionId, turnModel.id, ev.usage, true);
                }
                break;
              case 'error':
                streamError = ev.error;
                break;
            }
          }
        } catch (err) {
          streamError = err instanceof LLMError ? err : new LLMError('unknown', String((err as Error)?.message ?? err), {});
        }

        if (signal.aborted) {
          if (reasoningAcc && parts[0]) emitPart(assistantId, 0, parts[0]!, true);
          const textIdx = reasoningAcc ? 1 : 0;
          if (textAcc && parts[textIdx]) emitPart(assistantId, textIdx, parts[textIdx]!, true);
          completeInterruptedTools(assistantId, parts);
          break;
        }
        if (streamError) {
          completeInterruptedTools(assistantId, parts);
          await appendError(assistantId, parts, createdAt, friendlyLLMMessage(streamError), providerUsage);
          break;
        }

        if (reasoningAcc && parts[0]) emitPart(assistantId, 0, parts[0]!, true);
        const textIdx = reasoningAcc ? 1 : 0;
        if (textAcc && parts[textIdx]) emitPart(assistantId, textIdx, parts[textIdx]!, true);

        // 工具调用：执行后继续下一轮
        if (turnFinish === 'tool_calls' && turnToolCalls.length > 0) {
          let hadValid = false;
          for (const tc of turnToolCalls) {
            if (signal.aborted) break;
            // MCP 工具不在注册表：从本轮并入的 mcpTools 中查找
            const def = registry.get(tc.tool) ?? (tc.tool.startsWith('mcp_') ? mcpTools.find((t) => t.id === tc.tool) : undefined);
            // 未知/空工具：不询问权限，直接错误结果（避免挂起"执行中"）
            if (!def) {
              const callIdx = parts.findIndex((p) => p.type === 'tool-call' && p.callID === tc.callID);
              if (callIdx >= 0) {
                const callPart = parts[callIdx] as Extract<MessagePart, { type: 'tool-call' }>;
                parts[callIdx] = { ...callPart, state: 'error' };
                emitPart(assistantId, callIdx, parts[callIdx]!, true);
              }
              const resultIdx = parts.length;
              parts[resultIdx] = {
                type: 'tool-result',
                callID: tc.callID,
                output: null,
                state: 'error',
                error: tc.tool ? `未知工具：${tc.tool}` : '模型返回了空的工具调用',
              };
              emitPart(assistantId, resultIdx, parts[resultIdx]!, true);
              storage.updateMessageParts(assistantId, parts);
              continue;
            }
            hadValid = true;
            // doom-loop：同工具同参连续 3 次 → 询问是否继续
            const sig = `${tc.tool}:${JSON.stringify(tc.input ?? {})}`;
            doomCount = sig === lastCallSig ? doomCount + 1 : 1;
            lastCallSig = sig;
            let decision: PermissionDecision;
            if (doomCount >= 3) {
              decision = await this.requestPermission(sessionId, cwd, tc.tool, tc.input as Record<string, unknown>, signal);
              doomCount = 0;
              lastCallSig = '';
            } else {
              decision = await this.resolveForTool(sessionId, cwd, tc.tool, tc.input, turnAgent, settings, signal);
            }
            let result: { output?: unknown; error?: string };
            if (decision === 'deny') {
              result = { error: '用户拒绝了该操作' };
            } else {
              try {
                const output = await def.execute(tc.input as Record<string, unknown>, {
                  sessionId,
                  cwd,
                  settings,
                  signal,
                  tempDir: this.opts.attachmentsDir,
                  builtinSkillsDir: this.opts.builtinSkillsDir,
                  reportProgress: (text) => {
                    // 实时更新当前工具卡片标题（长任务进度，如视频生成轮询）
                    const idx = parts.findIndex((p) => p.type === 'tool-call' && p.callID === tc.callID);
                    if (idx >= 0) {
                      parts[idx] = { ...(parts[idx] as Extract<MessagePart, { type: 'tool-call' }>), title: text };
                      emitPart(assistantId, idx, parts[idx]!);
                      storage.updateMessageParts(assistantId, parts);
                    }
                  },
                  setAgent: async (agentId) => {
                    await this.patchSession(sessionId, { agentId });
                  },
                  ask: (req) => this.requestPermission(sessionId, cwd, req.tool, req.args as Record<string, unknown>, signal),
                  askUser: (q) => this.askUser(sessionId, signal, q.question, q.options),
                  todo: (input) => this.updateSessionTodo(sessionId, input),
                  runAgent: (prompt, aopts) =>
                    this.runSubAgent({
                      sessionId,
                      session,
                      settings,
                      registry,
                      cwd,
                      envBlock,
                      signal,
                      prompt,
                      agentOpts: aopts?.agentId ? { agent: aopts.agentId } : undefined,
                      disabledTools: turnDisabled,
                      append: (part) => {
                        const idx = parts.length;
                        parts.push(part);
                        emitPart(assistantId, idx, part);
                        storage.updateMessageParts(assistantId, parts);
                        return idx;
                      },
                      update: (idx, part) => {
                        parts[idx] = part;
                        emitPart(assistantId, idx, part);
                        storage.updateMessageParts(assistantId, parts);
                      },
                    }),
                });
                 if (isRichToolOutput(output)) {
                   // 富输出：图片/文件追加为独立 part（消息流直接呈现），模型只收文本
                   for (const img of output.images ?? []) {
                     const idx = parts.length;
                     parts[idx] = { type: 'image', dataUrl: img.dataUrl, name: img.name };
                     emitPart(assistantId, idx, parts[idx]!, true);
                     storage.updateMessageParts(assistantId, parts);
                   }
                   for (const f of output.files ?? []) {
                     const idx = parts.length;
                     parts[idx] = { type: 'file', name: f.name ?? basename(f.path), kind: f.kind ?? 'file', path: f.path };
                     emitPart(assistantId, idx, parts[idx]!, true);
                     storage.updateMessageParts(assistantId, parts);
                   }
                   result = { output: output.text };
                 } else {
                   result = { output };
                 }
              } catch (e) {
                result = { error: String((e as Error)?.message ?? e) };
              }
            }
            const callIdx = parts.findIndex((p) => p.type === 'tool-call' && p.callID === tc.callID);
            if (callIdx >= 0) {
              const callPart = parts[callIdx] as Extract<MessagePart, { type: 'tool-call' }>;
              parts[callIdx] = { ...callPart, state: result.error ? 'error' : 'completed' };
              emitPart(assistantId, callIdx, parts[callIdx]!, true);
            }
            const resultIdx = parts.length;
            parts[resultIdx] = result.error
              ? { type: 'tool-result', callID: tc.callID, output: null, state: 'error', error: result.error }
              : { type: 'tool-result', callID: tc.callID, output: result.output, state: 'completed' };
            emitPart(assistantId, resultIdx, parts[resultIdx]!, true);
            storage.updateMessageParts(assistantId, parts);
          }
          if (signal.aborted) break;
          // 本轮全部为无效工具调用 → 结束循环，避免空转"一直执行中"
          if (!hadValid) break;
          continue;
        }

        break;
      }
    } catch (err) {
      if (lastAssistantId && !finalized) {
        const message = friendlyLLMMessage(err instanceof LLMError ? err : new LLMError('unknown', String((err as Error)?.message ?? err), {}));
        await appendError(lastAssistantId, lastParts, Date.now(), message, providerUsage);
      }
    } finally {
      this.aborts.delete(sessionId);
    }

    // 显式设置的最大步数跑满：给用户可见提示，避免"无声停止"
    if (stepsExhausted && lastAssistantId && !finalized) {
      const idx = lastParts.length;
      lastParts[idx] = { type: 'text', text: '已达单次运行最大步数上限，本轮到此停止。你可以直接输入"继续"，我会接着当前进度往下做。' };
      emitPart(lastAssistantId, idx, lastParts[idx]!, true);
      storage.updateMessageParts(lastAssistantId, lastParts);
    }

    if (lastAssistantId && !finalized) {
      await finishNow(lastAssistantId, lastParts, 0, providerUsage);
    }

    // 标题自动生成（方案 C）：前 N 轮（titleAutoRounds）且未被用户编辑（title_source=auto）
    await this.maybeAutoTitle(sessionId);
  }

  /** 首条用户消息 + 最近一条助手回复 → 生成 ≤20 字标题；仅 auto 来源且轮数未超限时更新 */
  private async maybeAutoTitle(sessionId: string): Promise<void> {
    try {
      const storage = this.opts.db.storage;
      const session = storage.getSession(sessionId);
      if (!session || session.titleSource !== 'auto') return;
      const settings = await this.opts.config.read();
      const rounds = settings.general.titleAutoRounds ?? 1;
      if (rounds <= 0) return;
      const msgs = storage.pageMessages(sessionId, undefined, 300).messages;
      // 轮数 = 真实用户消息数（压缩 checkpoint 是合成 user 消息，不计）
      const userCount = msgs.filter((m) => m.role === 'user' && !m.parts.some((p) => p.type === 'compaction')).length;
      if (userCount > rounds) return;
      const userText =
        msgs
          .find((m) => m.role === 'user')
          ?.parts.filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ')
          .slice(0, 400) ?? '';
      const assistantText =
        ([...msgs].reverse().find((m) => m.role === 'assistant')?.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ') ?? '').slice(0, 400);
      if (!userText.trim() || !assistantText.trim()) return;
      const title = await this.generateTitle(sessionId, session, settings, userText, assistantText);
      if (!title) return;
      storage.patchSession(sessionId, { title }, Date.now(), 'auto');
      this.emit({ sessionId, type: 'session.updated', meta: { ...storage.getSession(sessionId)! } });
    } catch {
      // 标题生成失败静默保留现有标题
    }
  }

  /** 用会话模型生成标题（单次对话，走 streamChatImpl 便于测试注入） */
  private async generateTitle(
    sessionId: string,
    session: SessionMeta,
    settings: Settings,
    userText: string,
    assistantText: string,
  ): Promise<string | null> {
    try {
      const model = settings.models.find((m) => m.id === session.modelId);
      const provider = settings.providers.find((p) => p.id === model?.provider);
      if (!model || !provider?.apiKey) return null;
      const profile = getBuiltinProfile(provider.id) ?? createGenericProfile(provider.baseUrl);
      const request: ChatStreamRequest = {
        baseUrl: profile.baseUrl,
        apiKey: provider.apiKey,
        model: model.id,
        messages: [
          {
            role: 'system',
            content: '根据下面的对话开头生成一个不超过20个字的会话标题。直接输出标题本身，不要引号、句号或任何说明。',
          },
          { role: 'user', content: `用户：${userText}\n\n助手：${assistantText}` },
        ],
        thinking: 'off',
        maxTokens: 64,
        path: profile.path,
        headers: profile.headers,
        thinkingParams: profile.thinkingParams,
        reasoningField: profile.reasoningField,
        reasoningMessageField: profile.reasoningMessageField,
        reasoningPassthrough: profile.reasoningPassthrough,
        options: profile.options,
      };
      const stream = this.opts.streamChatImpl ? this.opts.streamChatImpl(request) : streamChat(request);
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'text-delta') text += ev.text;
      }
      const cleaned = text
        .trim()
        .replace(/^["'「『]+|["'」』。.]+$/g, '')
        .slice(0, 30)
        .trim();
      return cleaned || null;
    } catch {
      return null;
    }
  }

  /**
   * 逐轮用量上报：落库 + 广播累计总量（session.usage，"Token 消耗"块实时刷新）；
   * emitContext 时再广播本次请求用量（session.context，占用条实时刷新，仅主循环——子代理请求不代表主会话上下文）。
   */
  private reportUsage(sessionId: string, modelId: string, usage: Usage, emitContext = false): void {
    const storage = this.opts.db.storage;
    storage.appendUsage(sessionId, modelId, usage);
    const total = storage.getUsage(sessionId);
    if (total) this.emit({ sessionId, type: 'session.usage', usage: total });
    if (emitContext) this.emit({ sessionId, type: 'session.context', usage });
  }

  private async finalizeMessage(
    sessionId: string,
    messageId: string,
    parts: MessagePart[],
    createdAt: number,
    providerUsage: Usage | undefined,
  ): Promise<void> {
    const storage = this.opts.db.storage;
    const session = storage.getSession(sessionId);
    const textLength = parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
    const reasoningLength = parts.reduce((n, p) => n + (p.type === 'reasoning' ? p.text.length : 0), 0);
    const usage: Usage =
      providerUsage ??
      ({
        inputTokens: textLength > 0 || reasoningLength > 0 ? Math.round((textLength + reasoningLength) * 0.25) : 0,
        outputTokens: textLength,
        reasoningTokens: reasoningLength,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      } satisfies Usage);
    const message: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      parts,
      tokens: usage,
      cost: usage.cost,
      createdAt: createdAt || Date.now(),
    };
    storage.upsertMessage(message);
    // 逐轮用量已在 loop 内经 reportUsage 落库；此处仅兜底 provider 未回传 usage 时的字符估算
    if (!providerUsage) storage.appendUsage(sessionId, session?.modelId ?? '', usage);
    storage.updateSessionStatus(sessionId, 'idle');
    const total = storage.getUsage(sessionId);
    if (total) this.emit({ sessionId, type: 'session.usage', usage: total });
    this.emit({ sessionId, type: 'message.complete', messageId, message });
    this.emit({ sessionId, type: 'session.status', status: 'idle' });
  }
}
