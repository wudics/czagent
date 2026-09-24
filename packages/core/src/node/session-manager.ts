import { homedir, release, type } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AgentDef,
  AgentProvider,
  Attachment,
  AttachmentUpload,
  ChatMessage,
  ChatModelConfig,
  CreateSessionInput,
  MessagePart,
  MessagePage,
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
  SendMessageInput,
  SessionContext,
  ThinkingMode,
  SessionEvent,
  SessionMeta,
  SessionPatch,
  Settings,
  TodoItem,
  Usage,
} from '../provider.js';
import type { ConfigStore } from '../config/file.js';
import type { Db } from '../storage/client.js';
import { Gateway, type ResolvedChat } from '../llm/gateway.js';
import type { ChatEngine, ChatReq, LLMChatMessage } from '../llm/types.js';
import { LLMError, friendlyLLMMessage } from '../llm/errors.js';
import { createDefaultRegistry, ToolRegistry, INTERNAL_TOOLS } from '../tools/index.js';
import { UserRejectedError, type ToolDef } from '../tools/types.js';
import { isRichToolOutput } from '../tools/rich-output.js';
import { scanSkills, skillEnabled } from '../skills/discovery.js';
import { effectiveToolLoaded } from '../tools/policy.js';
import { applyTodo, todoToText, TODO_HINT, type TodoInput } from '../tools/todo.js';
import { isMcpServerEnabled, loadMcpConfig, readMcpLayers, writeGlobalMcpConfig } from '../mcp/config.js';
import { McpRegistry, mcpServerPrefix } from '../mcp/registry.js';
import { runEntryChild } from '../script/child.js';
import type { ScriptAgentRunOptions, ScriptUseOverrides } from '../script/types.js';
import { checkPermission, classifyBashCommand, extractTargetPath, pathInside, resolvePath } from '../permission/index.js';
import { patchFilePaths } from '../tools/patch.js';
import { attachmentKind, imageToDataUrl, parseAttachmentToText, textToMessagePart } from './attachments.js';
import {
  buildSummaryInstruction,
  estimateContextUsed,
  estimateRequestTokens,
  estimateTokens,
  estimateToolsTokens,
  findLastCompactionIndex,
  hasSummarySection,
  HISTORY_WINDOW_MESSAGES,
  pruneHistory,
  SATURATION_COMPACT_RATIO,
  selectTailStart,
  SUMMARY_REMINDER,
  tailBudget,
  truncateToolOutput,
} from '../compaction.js';
import { appendTurnReminder, buildTurnReminder } from '../reminders.js';
import { loadProjectInstructions, renderProjectInstructions, type InstructionsCacheEntry } from '../instructions.js';
import { composeSystemPrompt, SUB_AGENT_ADDENDUM } from '../settings-defaults.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 摘要请求中的工具输出截断上限（摘要只需要要点，10k 全文既慢又挤占预算） */
const SUMMARY_TOOL_OUTPUT_CHARS = 2_000;
/** 压缩单飞冲突提示（手动/自动互斥；runLoop 据此静默跳过，不作为错误展示） */
const COMPACTION_BUSY = '该会话已在压缩中';

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

/** MCP 工具清单 → 注入 env 的说明块（与工具注入同源，保证上下文估算与请求一致） */
function mcpNoteOf(tools: ToolDef[]): string {
  return tools.length > 0
    ? '\n\n<mcp_instructions>\n' + tools.map((t) => `- ${t.id}: ${t.description}`).join('\n') + '\n</mcp_instructions>'
    : '';
}

/**
 * ctx.agent.run 的 agent 解析（I19）：id 精确 → name 精确 → 缺省/空 = build；
 * 显式传入且两种都找不到 → 抛错（列出全部可用 agent），避免静默回退 build 造成误解。
 */
export function resolveAgentRef(agents: AgentDef[], ref?: string): AgentDef | undefined {
  if (!ref || !ref.trim()) return agents.find((a) => a.id === 'build');
  const key = ref.trim();
  return (
    agents.find((a) => a.id === key) ??
    agents.find((a) => a.name === key) ??
    (() => {
      const list = agents.map((a) => `${a.name}(${a.id})`).join('、');
      throw new Error(`未找到 agent：${key}（可用：${list}）`);
    })()
  );
}

export interface SessionManagerOptions {
  db: Db;
  config: ConfigStore;
  emit?: (ev: SessionEvent) => void;
  /** 可注入以替换对话引擎（测试用；覆盖所有 implId 的 chat 引擎） */
  chatEngineImpl?: ChatEngine;
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

/** 模型是否支持视觉输入（chat 模型看 vision 开关；多模态/图片理解模型视为支持） */
function visionOk(model: ChatModelConfig | Settings['multimodalModels'][number]): boolean {
  return !('vision' in model) || model.vision !== false;
}

/** 模型上下文窗口（0 = 未知；多模态模型无此字段） */
function contextLimitOf(model: ChatModelConfig | Settings['multimodalModels'][number]): number {
  return ('contextLimit' in model ? model.contextLimit : 0) ?? 0;
}

function buildRequestMessages(
  history: ChatMessage[],
  agentSystemPrompt?: string,
  env?: string,
  includeImages = true,
  reminder?: string,
  opts?: { toolOutputMaxChars?: number },
): LLMChatMessage[] {
  let out: LLMChatMessage[] = [];
  const systemParts = [
    agentSystemPrompt,
    env ? `<env>\n${env}\n</env>` : '',
  ].filter((s) => s && s.trim());
  if (systemParts.length > 0) out.push({ role: 'system', content: systemParts.join('\n\n') });
  for (const m of history) {
    if (m.role === 'user') {
      // 压缩 checkpoint 消息 → user 角色摘要（不用对话中部 system：部分 OpenAI 兼容后端拒绝非开头 system 消息）
      const compactionParts = m.parts.filter((p): p is Extract<MessagePart, { type: 'compaction' }> => p.type === 'compaction');
      if (compactionParts.length > 0) {
        out.push({
          role: 'user',
          content: `以下内容是系统对此前对话的自动摘要（非用户发言），请在此基础上继续对话：\n${compactionParts.map((p) => p.summary).join('\n')}`,
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
    // synthetic text 仅展示不进请求（如 plan 工具的可见计划全文；tool-call 参数里已有一份，避免双份入上下文）
    const text = m.parts
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text' && !p.synthetic)
      .map((p) => p.text)
      .join('\n');
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
        content: result ? truncateToolOutput(toolResultContent(result), cp.tool, opts?.toolOutputMaxChars) : '（该工具调用未执行/已中断）',
        toolCallId: cp.callID,
      });
    }
  }
  // 逐轮提醒：请求时拼装（不落库），追加到最后一条消息（新输入轮为 user，工具续轮为 tool）
  out = appendTurnReminder(out, reminder ?? '');
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
  /** plan 工具最近提交的计划文本（模式切换提醒锚定用；跨 runLoop 保留，会话删除时清理） */
  private readonly lastPlans = new Map<string, string>();
  /** AGENTS.md 指令缓存（cwd → {mtime,size,content}，文件变更自动失效） */
  private readonly instructionsCache = new Map<string, InstructionsCacheEntry>();
  /** Git 分支名缓存（cwd → 分支，会话生命周期内变化少，接受轻微过期） */
  private readonly gitBranchCache = new Map<string, string>();
  /** 正在运行的 runLoop 数（并发槽位） */
  private activeLoops = 0;
  /** 等待槽位的会话队列（sessionId） */
  private readonly queue: string[] = [];
  /** 进行中的压缩任务（单飞注册表：sessionId → 占位块消息 id + 中止控制器；手动/自动互斥） */
  private readonly compactingSessions = new Map<string, { messageId: string; controller: AbortController }>();
  /** 手动压缩并行数（上限复用 maxConcurrency）与 FIFO 等待队列 */
  private compactionActive = 0;
  private readonly compactionQueue: Array<() => void> = [];
  /** 已进入手动压缩流程（含排队等待）的会话：关闭"排队期间重复点击"窗口 */
  private readonly manualCompactionQueued = new Set<string>();
  /** MCP 客户端注册表（应用级缓存：懒连接/错误隔离） */
  private readonly mcp = new McpRegistry();
  /** LLM 网关：模型解析/校验/路由的唯一入口（无状态，按调用传入 settings） */
  readonly gateway = new Gateway();

  /** 对话引擎选择：测试注入覆盖优先，否则按模型 implId 注册表 */
  private engineFor(target: ResolvedChat): ChatEngine {
    return this.opts.chatEngineImpl ?? target.engine;
  }

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
    // 默认模型：chat 能力绑定优先，未绑定则取第一个启用的对话模型
    const boundChatId = settings.bindings.find((b) => b.capability === 'chat')?.modelId ?? '';
    const boundChat = settings.chatModels.find((m) => m.id === boundChatId && m.enabled);
    const defaultChat = boundChat?.id ?? settings.chatModels.find((m) => m.enabled)?.id ?? '';
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
    // 中止该会话进行中的压缩（手动/自动统一走单飞注册表）；排队中的任务由槽位复核兜底退出
    this.compactingSessions.get(id)?.controller.abort();
    this.compactingSessions.delete(id);
    // 若在并发队列中等待，先出队（后续 pumpQueue 会跳过不存在的会话）
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.todos.delete(id);
    this.lastPlans.delete(id);
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
      const target = this.gateway.resolveChatOrNull(settings, settings.bindings.find((b) => b.capability === 'image-understanding')?.modelId ?? '');
      if (!target || !target.vision) return null;
      const request: ChatReq = {
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
      };
      const stream = this.engineFor(target).stream(target.binding, request);
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'text-delta') text += ev.text;
        // 图片描述调用产生的真实成本计入会话（旁路 LLM 不可"隐身"）
        if (ev.type === 'finish' && ev.usage) this.reportUsage(sessionId, target.modelId, ev.usage);
      }
      const trimmed = text.trim();
      return trimmed ? `${trimmed}` : null;
    } catch {
      return null;
    }
  }

  // ---- 上下文压缩 ----

  /** contextLimit<=0（未知）或 auto=false → 返回 null（不自动压缩）；否则返回可用 token 预算。
   * 预留 = max(reservedTokens, min(maxOutput, 32k))：输出同样占用窗口（对齐 opencode），避免触发过晚 */
  private compactionUsable(contextLimit: number, settings: Settings, maxOutput = 0): number | null {
    const cl = contextLimit ?? 0;
    const c = settings.general?.compaction;
    if (cl <= 0 || !c?.auto) return null;
    const reserved = Math.max(c.reservedTokens, Math.min(maxOutput > 0 ? maxOutput : 0, 32_000));
    const u = cl - reserved;
    return u > 0 ? u : null;
  }

  /** 最后一个 compaction checkpoint 在消息数组中的下标；无则 -1 */
  private lastCompactionIndex(messages: ChatMessage[]): number {
    return findLastCompactionIndex(messages);
  }

  /**
   * 请求窗口：无 checkpoint → 全量；有 → [checkpoint, ...边界之后原文]。
   * 新格式 checkpoint（coversBefore）显示在完成时刻（时间线较后），按语义边界构窗：
   * 摘要 + coversBefore 之后的原文（保留尾部 + 新消息，时间序）进请求，更早历史跳过。
   * 旧格式（无 coversBefore）回退按消息定位切窗。多个 checkpoint 以最后一个为准
   * （更早的已被合并进最新摘要，且其 createdAt <= 最新边界，天然被过滤）。
   * saturated = 加载窗口被条数上限截断（窗内无 checkpoint 且页外还有更早消息）：
   * 是否真的压缩由调用方按占用比例门槛裁决（低占比不再仅因条数全窗压缩）。
   */
  private historyWindow(sessionId: string): { messages: ChatMessage[]; saturated: boolean } {
    const page = this.opts.db.storage.pageMessages(sessionId, undefined, HISTORY_WINDOW_MESSAGES);
    const idx = this.lastCompactionIndex(page.messages);
    if (idx < 0) return { messages: page.messages, saturated: page.hasMore };
    const checkpoint = page.messages[idx]!;
    const coversBefore = checkpoint.parts.find(
      (p): p is Extract<MessagePart, { type: 'compaction' }> => p.type === 'compaction' && typeof p.coversBefore === 'number',
    )?.coversBefore;
    if (coversBefore !== undefined) {
      const tail = page.messages.filter((m) => m.id !== checkpoint.id && m.createdAt > coversBefore);
      return { messages: [checkpoint, ...tail], saturated: false };
    }
    return { messages: page.messages.slice(idx), saturated: false };
  }

  /** 摘要压缩：old 区折叠为摘要并写 DB checkpoint（旧消息保留在 DB，仅请求窗口跳过）。
   * checkpointId 传入时复用为 checkpoint 消息 id（与流式占位块同一 id，渲染层按 id 归位）；
   * onSummaryDelta 在摘要流式增长时回调（占位块实时显示）。
   * 返回 compacted=false + error 非空 = 摘要调用失败（调用方决定提示方式）；old 为空 = 无可压缩（无 error） */
  private async maybeCompact(opts: {
    sessionId: string;
    settings: Settings;
    target: ResolvedChat;
    signal: AbortSignal;
    /** 已 prune 的请求窗口 */
    history: ChatMessage[];
    usable: number;
    /** 摘要调用的思考模式（跟随会话；强制 off 会让 thinking-only 供应商空正文） */
    thinking: ThinkingMode;
    checkpointId?: string;
    onSummaryDelta?: (text: string) => void;
  }): Promise<{ compacted: boolean; error?: string }> {
    const { sessionId, settings, target, signal, history, usable, thinking, checkpointId, onSummaryDelta } = opts;
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
    if (old.length === 0) return { compacted: false };
    const { summary, error } = await this.summarize(sessionId, settings, target, old, signal, thinking, previousSummary, onSummaryDelta);
    if (!summary) return { compacted: false, error: error ?? '摘要生成失败' };

    // 会话可能已被删除（删除会话会中止压缩）：落库前复核，避免孤儿 checkpoint
    if (!this.opts.db.storage.getSession(sessionId)) return { compacted: false, error: '会话已删除' };
    const keep = history.slice(tailStart);
    // 显示位置 = 压缩完成时刻（时间线底部原地保留，随后随新对话自然上移）；
    // 语义边界 = 尾部最旧一条之前（coversBefore），historyWindow 据此构窗：摘要进请求 + 尾部原文保留
    const coversBefore = keep.length > 0 ? keep[0]!.createdAt - 1 : Date.now();
    const checkpoint: ChatMessage = {
      id: checkpointId ?? nextId('u'),
      sessionId,
      role: 'user',
      parts: [{ type: 'compaction', summary, coversBefore }],
      createdAt: Date.now(),
    };
    this.opts.db.storage.insertMessage(checkpoint);
    // 推送 checkpoint：渲染层按同 id 原地替换流式占位块，摘要条保留在时间线底部
    this.emit({ sessionId, type: 'session.compacted', message: checkpoint });
    return { compacted: true };
  }

  /**
   * 压缩任务统一执行（手动/自动共用）：单飞注册 → 时间线占位块流式显示摘要 → maybeCompact → 事件清理。
   * 对齐 opencode：压缩在时间线可见（占位块随摘要流式增长，完成后以同一 id 归位到历史中缝）。
   * signal 为外部中止信号（如 runLoop 的会话信号；删除会话通过注册表内的 controller 中止）。
   * 单飞冲突返回 { compacted:false, error: COMPACTION_BUSY }。
   */
  private async executeCompaction(opts: {
    sessionId: string;
    settings: Settings;
    target: ResolvedChat;
    /** 外部中止信号（可缺省；删除会话经由注册表内 controller 中止） */
    signal?: AbortSignal;
    /** 已 prune 的请求窗口 */
    history: ChatMessage[];
    usable: number;
    /** 摘要调用的思考模式（跟随会话；见 summarizeOnce 空正文兜底） */
    thinking: ThinkingMode;
  }): Promise<{ compacted: boolean; error?: string }> {
    const { sessionId, signal: externalSignal } = opts;
    if (this.compactingSessions.has(sessionId)) return { compacted: false, error: COMPACTION_BUSY };
    const messageId = nextId('u');
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    this.compactingSessions.set(sessionId, { messageId, controller });
    // 占位块：空摘要首帧立即出现在时间线底部，随摘要流式增长
    const emitPlaceholder = (summary: string): void => {
      this.emit({ sessionId, type: 'message.part.delta', messageId, partIndex: 0, part: { type: 'compaction', summary } });
    };
    this.emit({ sessionId, type: 'session.compacting', active: true, messageId });
    emitPlaceholder('');
    try {
      return await this.maybeCompact({
        sessionId,
        settings: opts.settings,
        target: opts.target,
        signal: controller.signal,
        history: opts.history,
        usable: opts.usable,
        thinking: opts.thinking,
        checkpointId: messageId,
        onSummaryDelta: emitPlaceholder,
      });
    } finally {
      this.compactingSessions.delete(sessionId);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      // 失败时渲染层据 messageId 清理占位块；成功时 session.compacted 已按同 id 归位（幂等）
      this.emit({ sessionId, type: 'session.compacting', active: false, messageId });
    }
  }

  /** 手动压缩排队：并行上限复用 maxConcurrency，FIFO 等待；返回释放槽位的函数 */
  private async acquireCompactionSlot(): Promise<() => void> {
    for (;;) {
      let limit = 4;
      try {
        limit = (await this.opts.config.read()).general.maxConcurrency || 4;
      } catch {
        // 读取失败按缺省 4
      }
      if (this.compactionActive < limit) break;
      await new Promise<void>((resolve) => this.compactionQueue.push(resolve));
    }
    this.compactionActive += 1;
    return () => {
      this.compactionActive -= 1;
      this.compactionQueue.shift()?.();
    };
  }

  /**
   * 用摘要模型（compaction.modelId 可选，缺省会话模型）把旧消息总结为结构化摘要。
   * 图片剥占位、工具输出截 2k、请求总预算上限——超限按消息粒度分块顺序摘要，
   * previousSummary（既有摘要）逐块并入新摘要（见 buildSummaryInstruction 的合并指令）。
   */
  private async summarize(
    sessionId: string,
    settings: Settings,
    fallbackTarget: ResolvedChat,
    history: ChatMessage[],
    signal: AbortSignal,
    thinking: ThinkingMode,
    previousSummary?: string,
    onSummaryDelta?: (text: string) => void,
  ): Promise<{ summary?: string; error?: string }> {
    const modelId = settings.general.compaction.modelId;
    const target = (modelId ? this.gateway.resolveChatOrNull(settings, modelId) : undefined) ?? fallbackTarget;
    const stripped = history.map((m) => ({
      ...m,
      parts: m.parts.flatMap((p) =>
        p.type === 'image' ? [{ type: 'text' as const, text: `[图片附件: ${p.name ?? '未命名'}]` }] : [p],
      ),
    }));
    // 摘要请求总预算：模型窗口已知 → clamp(窗口 − 4k, 16k, 96k)；未知 → 48k 兜底
    const windowTokens = target.contextLimit > 0 ? target.contextLimit : 52_000;
    const budget = Math.min(Math.max(windowTokens - 4_000, 16_000), 96_000);
    // 消息粒度分块：call/result 同属一条 assistant 消息，按消息切分不会拆散配对
    const chunks: ChatMessage[][] = [];
    let cur: ChatMessage[] = [];
    for (const m of stripped) {
      cur.push(m);
      if (cur.length > 1 && estimateRequestTokens(buildRequestMessages(cur, undefined, undefined, true, undefined, { toolOutputMaxChars: SUMMARY_TOOL_OUTPUT_CHARS })) > budget) {
        chunks.push(cur.slice(0, -1));
        cur = [m];
      }
    }
    if (cur.length > 0) chunks.push(cur);
    let merged = previousSummary;
    for (const chunk of chunks) {
      const res = await this.summarizeOnce(sessionId, target, chunk, thinking, merged, signal, (partial) => {
        // 流式回调携带"已合并摘要 + 当前块增量"，多块场景占位块持续增长不回退
        onSummaryDelta?.((merged ? `${merged}\n\n` : '') + partial);
      });
      if (!res.summary) return { error: res.error };
      merged = res.summary;
    }
    return merged ? { summary: merged } : { error: '模型未返回摘要内容' };
  }

  /**
   * 单次摘要请求（对齐 opencode compaction 规则）：
   * - 摘要指令恒为请求的最后一条 user 消息（含模板），不再放 system、不依赖历史里有 user 轮
   *   ——修复 vLLM 系后端 "No user query found in messages" 400；
   * - 输出预算用模型 maxOutput（钳 ≤32k），不再缩到 2048（thinking 模型思考+成文都要预算）；
   * - hasSummarySection 结构校验：有正文但不合模板 → 同消息 + 追问 user 再发一次（每轮 ≤2 请求）；
   * - 正文为空 → 末位用 reasoning 兜底（有意宽于 opencode，救只吐思考的端点）；
   * - finish=length 即失败不重试（预算已是模型上限）；auth/invalid（retryable=false）不重烧；
   * - 每个请求的 usage 各自入账会话。
   */
  private async summarizeOnce(
    sessionId: string,
    target: ResolvedChat,
    chunk: ChatMessage[],
    thinking: ThinkingMode,
    previousSummary: string | undefined,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
  ): Promise<{ summary?: string; error?: string }> {
    const historyMessages = buildRequestMessages(chunk, undefined, undefined, true, undefined, {
      toolOutputMaxChars: SUMMARY_TOOL_OUTPUT_CHARS,
    });
    const instruction = buildSummaryInstruction(previousSummary);
    const maxTokens = Math.min(target.maxOutput > 0 ? target.maxOutput : 8_192, 32_000);
    const sendOnce = async (
      reminder: boolean,
    ): Promise<{ text: string; reasoning: string; finishReason?: string; err?: { message: string; retryable?: boolean } }> => {
      try {
        const messages: LLMChatMessage[] = reminder
          ? [...historyMessages, { role: 'user', content: instruction }, { role: 'user', content: SUMMARY_REMINDER }]
          : [...historyMessages, { role: 'user', content: instruction }];
        const request: ChatReq = { messages, thinking, maxTokens, signal };
        const stream = this.engineFor(target).stream(target.binding, request);
        let text = '';
        let reasoning = '';
        let usage: Usage | undefined;
        let finishReason: string | undefined;
        for await (const ev of stream) {
          if (ev.type === 'text-delta') {
            text += ev.text;
            onDelta?.(text);
          } else if (ev.type === 'reasoning-delta') {
            reasoning += ev.text;
          } else if (ev.type === 'finish') {
            if (ev.usage) usage = ev.usage;
            finishReason = ev.finishReason;
          }
        }
        if (usage) this.reportUsage(sessionId, target.modelId, usage);
        return { text, reasoning, finishReason };
      } catch (err) {
        const e = err instanceof LLMError ? err : new LLMError('unknown', String((err as Error)?.message ?? err), {});
        return { text: '', reasoning: '', err: { message: friendlyLLMMessage(e), retryable: e.retryable } };
      }
    };
    let attempt = await sendOnce(false);
    if (!signal.aborted) {
      if (attempt.err && !attempt.text.trim() && !attempt.reasoning.trim() && attempt.err.retryable !== false) {
        // 瞬态错误（限流/网络/流中断且无任何产出）：等 800ms 同请求重发一次
        await new Promise<void>((resolve) => setTimeout(resolve, 800));
        onDelta?.('');
        attempt = await sendOnce(false);
      } else if (!attempt.err && attempt.text.trim() && !hasSummarySection(attempt.text)) {
        // 结构校验失败：追问重试一次（opencode 同款——不带首轮输出，仅追加提醒消息）
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        onDelta?.('');
        attempt = await sendOnce(true);
      }
    }
    const finalText = attempt.text.trim() || stripThinkTags(attempt.reasoning).trim();
    if (finalText) return { summary: finalText };
    if (attempt.err) return { error: attempt.err.message };
    if (attempt.finishReason === 'length') return { error: '未返回摘要正文（输出预算耗尽 finish=length）' };
    // 诊断带 finish 原因（tool_calls=模型试图继续任务而非写摘要）
    return { error: `未返回摘要内容${attempt.finishReason ? `（finish=${attempt.finishReason}）` : ''}` };
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
      const model = settings.chatModels.find((m) => m.id === session.modelId);
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

  /** 手动压缩上下文：把旧历史折叠为摘要 checkpoint（非破坏）。不受 auto 开关限制；
   * 跨会话并行执行（切换会话不影响），并行上限复用 maxConcurrency、超出 FIFO 排队；
   * 仅限 idle 会话；返回是否实际压缩（false=无可压缩内容）；摘要调用失败抛错（UI 区分"失败/没得压"） */
  async compactSession(sessionId: string): Promise<boolean> {
    const storage = this.opts.db.storage;
    const session = storage.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    if (session.status !== 'idle') throw new Error('会话正在运行，无法压缩');
    if (this.compactingSessions.has(sessionId) || this.manualCompactionQueued.has(sessionId)) throw new Error(COMPACTION_BUSY);
    this.manualCompactionQueued.add(sessionId);
    const settings = await this.opts.config.read();
    const target = this.gateway.resolveChat(settings, session.modelId);
    // contextLimit 未知（<=0）或 auto 关闭时传极大预算：尾部预算钳到 15k + 条数上限 200，按此压缩
    const usable = this.compactionUsable(target.contextLimit, settings, target.maxOutput) ?? Number.MAX_SAFE_INTEGER;
    // 排队等槽位；拿到槽位后复核状态并重读窗口（排队期间可能有新消息/会话已开始运行/被删除）
    const release = await this.acquireCompactionSlot();
    try {
      const current = storage.getSession(sessionId);
      if (!current) throw new Error('会话不存在');
      if (current.status !== 'idle') throw new Error('会话正在运行，无法压缩');
      const history = pruneHistory(this.historyWindow(sessionId).messages);
      const result = await this.executeCompaction({ sessionId, settings, target, history, usable, thinking: current.thinkingMode });
      if (!result.compacted && result.error) throw new Error(result.error);
      // 压缩成功 → 重算新窗口占用并推送，右侧面板百分比立即回落
      if (result.compacted) {
        const ctx = await this.computeContext(sessionId);
        if (ctx) this.emit({ sessionId, type: 'session.context', ...ctx });
      }
      return result.compacted;
    } finally {
      this.manualCompactionQueued.delete(sessionId);
      release();
    }
  }

  /** 当前上下文占用（切换会话时初始拉取；此后由各发射点推送 session.context 事件） */
  async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    return this.computeContext(sessionId);
  }

  /**
   * 计算当前上下文占用（含 system prompt/env/MCP 说明）。
   * 口径与 runLoop 压缩触发完全一致（同一 estimateContextUsed = 锚点 usageTotal + 锚点后增量），
   * 面板百分比与触发线不再有"表低实高"的偏差（历史上此不一致导致 33% 就触发压缩）。
   */
  private async computeContext(sessionId: string): Promise<SessionContext | null> {
    const session = this.opts.db.storage.getSession(sessionId);
    if (!session) return null;
    const settings = await this.opts.config.read();
    const model = settings.chatModels.find((m) => m.id === session.modelId) ?? settings.multimodalModels.find((m) => m.id === session.modelId && m.capability === 'image-understanding');
    if (!model) return null;
    const agent = settings.agents.find((a) => a.id === session.agentId);
    const cwd = session.cwd || homedir();
    const history = pruneHistory(this.historyWindow(sessionId).messages);
    const envBlock = await this.buildEnvBlock(cwd, agent, settings);
    const mcpTools = await this.mcpToolsFor(cwd, agent, new Set<string>());
    const requestMessages = buildRequestMessages(history, composeSystemPrompt(agent), envBlock + mcpNoteOf(mcpTools), visionOk(model));
    // 工具 schema 占用与 runLoop 同源估算（无 usage 锚点时两值才相等；有锚点时锚点已含）
    const registry = this.opts.registry ?? createDefaultRegistry();
    const turnDisabled = webAccessDisabled(session);
    const enabledTools = registry
      .list()
      .filter((t) => !turnDisabled.has(t.id) && effectiveToolLoaded(agent, settings.permissions.default, t.id));
    const toolsTokens = estimateToolsTokens(registry.toOpenAI(enabledTools.concat(mcpTools)));
    const used = estimateContextUsed(history, estimateRequestTokens(requestMessages) + toolsTokens);
    return { used, limit: contextLimitOf(model) };
  }

  /** 请求 env 块：平台/OS/工作目录/日期 + Git 仓库状态 + AGENTS.md 指令 + 可用技能清单（runLoop 与上下文估算共用，保证口径一致） */
  private async buildEnvBlock(cwd: string, agent: AgentDef | undefined, settings: Settings): Promise<string> {
    const osLine = `${type()} ${release()} (${process.arch})`;
    let envBlock = `当前系统平台：${process.platform} (${process.arch})\n操作系统：${osLine}\n会话工作目录：${cwd}\n当前日期：${new Date().toISOString().slice(0, 10)}`;
    // Git 仓库状态（cwd 级缓存，采集失败静默视为非仓库）
    const git = await this.gitInfoOf(cwd);
    if (git) envBlock += `\nGit 仓库：是（分支 ${git}）`;
    // AGENTS.md 项目指令（P1：instructions 槽位，mtime 缓存）
    try {
      const instructions = await loadProjectInstructions(cwd, this.instructionsCache);
      envBlock += renderProjectInstructions(instructions);
    } catch {
      // 指令加载失败不影响会话
    }
    // 技能发现：有技能则注入 <available_skills>，agent 按需用 skill 工具加载
    // I13.3：逐条(skillOverrides) + 全局禁用名单，取 load(s)
    try {
      const disabledSkills = settings.general.disabledSkills ?? [];
      const skills = (await scanSkills(cwd, this.opts.builtinSkillsDir)).filter((s) => skillEnabled(s.name, agent, disabledSkills));
      if (skills.length > 0) {
        envBlock +=
          '\n\n<available_skills>\n' +
          skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') +
          '\n</available_skills>\n当任务与上述技能描述匹配时，先调用 skill 工具加载其完整说明（name 参数填技能名），再按说明行动。';
      }
    } catch {
      // 技能扫描失败不影响会话
    }
    return envBlock;
  }

  /** Git 分支名（cwd 级缓存；非仓库/无 git 可执行文件 → null） */
  private async gitInfoOf(cwd: string): Promise<string | null> {
    const cached = this.gitBranchCache.get(cwd);
    if (cached) return cached;
    try {
      const { stdout } = await promisify(execFile)('git', ['branch', '--show-current'], { cwd, timeout: 3000 });
      const branch = stdout.trim();
      if (!branch) return null;
      this.gitBranchCache.set(cwd, branch);
      return branch;
    } catch {
      return null;
    }
  }

  /** MCP 工具清单：按 agent 生效服务器名单（全开=全局 enabled 且非 off；受限=点名 on），剔除运行中禁用项 */
  private async mcpToolsFor(cwd: string, agent: AgentDef | undefined, disabled: Set<string>): Promise<ToolDef[]> {
    const allowedServers = this.allowedMcpServers(cwd, agent);
    if (allowedServers.length === 0) return [];
    return (await this.mcp.getTools(cwd, this.opts.globalMcpDir, allowedServers)).filter((t) => !disabled.has(t.id));
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
    // 启动前校验会话模型可用（Key/接口实现），不可用则给出可见错误并早退
    try {
      this.gateway.resolveChat(settings, session.modelId);
    } catch (e) {
      const scriptMsgId = nextId('a');
      const createdAt = Date.now();
      const parts: MessagePart[] = [];
      storage.insertMessage({ id: scriptMsgId, sessionId, role: 'assistant', parts: [], createdAt });
      parts.push({ type: 'error', message: String((e as Error)?.message ?? e) });
      storage.updateMessageParts(scriptMsgId, parts);
      this.emit({ sessionId, type: 'message.part.delta', messageId: scriptMsgId, partIndex: 0, part: parts[0]! });
      await this.finalizeMessage(sessionId, scriptMsgId, parts, createdAt, undefined);
      this.aborts.delete(sessionId);
      return;
    }
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

      // MCP 工具定义：按 agent 生效名单预载；ctx.use 覆盖后按需懒加载（bridge 侧 toolId → def 覆盖，其余走 registry）
      const scriptMcpAllowed = this.allowedMcpServers(cwd, agent);
      const mcpDefById = new Map<string, ToolDef>();
      const loadMcpDefs = async (servers: string[]): Promise<void> => {
        if (servers.length === 0) return;
        for (const t of await this.mcp.getTools(cwd, this.opts.globalMcpDir, servers)) mcpDefById.set(t.id, t);
      };
      await loadMcpDefs(scriptMcpAllowed);
      // ctx.use 覆盖（I19）：null = 未设置；数组 = 权威名单（空数组全关）
      let useMcpServers: string[] | null = null;
      let useSkills: string[] | null = null;

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
            // ctx.use MCP 门控（I19）：覆盖生效时按脚本名单归属；名单内但定义未载 → 懒加载
            if (toolId.startsWith('mcp_') && useMcpServers !== null) {
              const server = useMcpServers.find((n) => toolId.startsWith(mcpServerPrefix(n)));
              if (!server) throw new Error(`MCP 服务器未在 ctx.use 名单中，无法调用 ${toolId}`);
              if (!mcpDefById.has(toolId)) await loadMcpDefs([server]);
            }
            const def = mcpDefById.get(toolId);
            return this.runScriptTool({
              registry,
              toolId,
              ...(def ? { def } : {}),
              input,
              sessionId,
              cwd,
              settings,
              agent,
              signal,
              append,
              update,
              ...(timeoutMs ? { timeoutMs } : {}),
              ...(useSkills !== null ? { allowedSkills: useSkills } : {}),
            });
          },
          onAgentRun: (prompt, agentOpts) =>
            this.runSubAgent({ sessionId, session, settings, registry, cwd, envBlock, signal, prompt, agentOpts, disabledTools: webAccessDisabled(session), append, update }),
          onUse: (patch: ScriptUseOverrides) => {
            if ('mcpServers' in patch) useMcpServers = Array.isArray(patch.mcpServers) ? patch.mcpServers.map(String) : null;
            if ('skills' in patch) useSkills = Array.isArray(patch.skills) ? patch.skills.map(String) : null;
          },
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
    /** ctx.use 技能白名单覆盖（I19）：透传给 skill 工具的 allowedSkills */
    allowedSkills?: string[];
    signal: AbortSignal;
    /** 单次调用超时毫秒（缺省/0 = 不限） */
    timeoutMs?: number;
    append: (part: MessagePart) => number;
    update: (idx: number, part: MessagePart) => void;
  }): Promise<unknown> {
    const { registry, toolId, input, sessionId, cwd, settings, agent, signal, timeoutMs, append, update, allowedSkills, def: defOverride } = opts;
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
        gateway: this.gateway,
        signal: callCtrl.signal,
        tempDir: this.opts.attachmentsDir,
        builtinSkillsDir: this.opts.builtinSkillsDir,
        ...(allowedSkills ? { allowedSkills } : {}),
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
        // 富输出：图片/文件/markdown 追加为独立 part，tool-result 只收文本
        for (const img of output.images ?? []) {
          append({ type: 'image', dataUrl: img.dataUrl, name: img.name });
        }
        for (const f of output.files ?? []) {
          append({ type: 'file', name: f.name ?? basename(f.path), kind: f.kind ?? 'file', path: f.path });
        }
        if (output.markdown) {
          append({ type: 'text', text: output.markdown.text, synthetic: true });
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
    // agent 解析（I19）：id 精确 → name 精确 → 显式传入找不到抛错；缺省/空 = build
    const agentDef = resolveAgentRef(settings.agents, agentOpts?.agent);
    // 工具绑定：agentOpts.tools 显式白名单；否则按 agent 矩阵 load 链；plan/plan-exit 子运行永远排除
    const rules = settings.permissions.default;
    // 子代理禁止再派生/问询：task 防嵌套、question 保持主会话专用
    const SUB_AGENT_HIDDEN = ['task', 'question'];
    // MCP 服务器名单（I19 权威覆盖）：显式传入即按脚本名单（仅限 mcp.json 已配置服务器，未知名忽略）；
    // 缺省 = 按 agent 的三态设置（跟随全局/强制开/排除）计算生效名单
    let mcpAllowed: string[];
    if (agentOpts?.mcpServers) {
      let configured: string[] = [];
      try {
        configured = Object.keys(loadMcpConfig(cwd, this.opts.globalMcpDir));
      } catch {
        configured = [];
      }
      mcpAllowed = agentOpts.mcpServers.filter((n) => configured.includes(n));
    } else {
      mcpAllowed = this.allowedMcpServers(cwd, agentDef);
    }
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
    const target =
      this.gateway.resolveChatOrNull(settings, agentOpts?.model ?? '') ??
      this.gateway.resolveChat(settings, session.modelId);
    // 步数：agentOpts.maxSteps 显式覆盖 > agent 定义 steps > 不限（与设置界面"留空=不限"一致）
    const maxSteps =
      agentOpts?.maxSteps && agentOpts.maxSteps > 0
        ? agentOpts.maxSteps
        : agentDef?.steps && agentDef.steps > 0
          ? agentDef.steps
          : Number.POSITIVE_INFINITY;
    const canTool = target.toolcall;

    const promptMsg: ChatMessage = {
      id: 'sub-prompt',
      sessionId,
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
      createdAt: 0,
    };
    const messages = buildRequestMessages([promptMsg], composeSystemPrompt(agentDef) + '\n\n' + SUB_AGENT_ADDENDUM, envBlock, target.vision);

    let finalText = '';
    let streamAcc = '';
    let agentTextIdx = -1;
    let exhausted = true;

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) {
        exhausted = false;
        return finalText;
      }
      const request: ChatReq = {
        messages,
        thinking: session.thinkingMode,
        maxTokens: target.maxOutput > 0 ? target.maxOutput : undefined,
        signal,
        options: target.options,
        tools: canTool && resolved.length > 0 ? registry.toOpenAI(resolved) : undefined,
      };

      streamAcc = '';
      const turnToolCalls: { callID: string; tool: string; input: unknown; parseError?: string }[] = [];
      let streamError: LLMError | undefined;
      // callID → 已挂卡片下标（流中 start 建 pending 卡，执行时复用同一张卡）
      const callCardIdx = new Map<string, number>();
      const callCardTool = new Map<string, string>();
      const stream = this.engineFor(target).stream(target.binding, request);
      try {
        for await (const ev of stream) {
          if (ev.type === 'text-delta') {
            streamAcc += ev.text;
            const part: MessagePart = { type: 'text', text: `[agent] ${streamAcc}` };
            if (agentTextIdx < 0) agentTextIdx = append(part);
            else update(agentTextIdx, part);
          } else if (ev.type === 'tool-call-start') {
            // 流中即建 pending 卡（与主循环同口径）；callID 缺失时等 tool-call 事件再建卡
            if (ev.callID && !callCardIdx.has(ev.callID)) {
              callCardIdx.set(ev.callID, append({ type: 'tool-call', tool: ev.tool, callID: ev.callID, input: {}, state: 'pending' }));
              callCardTool.set(ev.callID, ev.tool);
            }
          } else if (ev.type === 'tool-call') {
            turnToolCalls.push({ callID: ev.callID, tool: ev.tool, input: ev.input, ...(ev.parseError ? { parseError: ev.parseError } : {}) });
            const idx = callCardIdx.get(ev.callID);
            if (idx !== undefined) update(idx, { type: 'tool-call', tool: ev.tool, callID: ev.callID, input: ev.input, state: 'running' });
          } else if (ev.type === 'finish') {
            if (ev.usage) this.reportUsage(sessionId, target.modelId, ev.usage);
          } else if (ev.type === 'error') {
            streamError = ev.error;
          }
        }
      } catch (err) {
        streamError = err instanceof LLMError ? err : new LLMError('unknown', String((err as Error)?.message ?? err), {});
      }

      if (signal.aborted) {
        exhausted = false;
        // 中断时 pending 卡标记 error，避免脚本消息里永远"执行中"
        for (const [cid, idx] of callCardIdx) {
          update(idx, { type: 'tool-call', tool: callCardTool.get(cid) ?? '', callID: cid, input: {}, state: 'error' });
        }
        return finalText || streamAcc;
      }
      if (streamError) {
        if (agentTextIdx >= 0) update(agentTextIdx, { type: 'text', text: `[agent] ${streamAcc}` });
        // 流中失败的 pending 卡标记 error，避免脚本消息里永远"执行中"
        for (const [cid, idx] of callCardIdx) {
          update(idx, { type: 'tool-call', tool: callCardTool.get(cid) ?? '', callID: cid, input: {}, state: 'error' });
        }
        throw new Error(friendlyLLMMessage(streamError));
      }

      // 不依赖 finish_reason：部分平台 stop 也携带工具调用（与主循环同口径）
      if (turnToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: streamAcc || null,
          // 空工具名的调用不回传（provider 会 400）；其错误仅作为卡片展示
          toolCalls: turnToolCalls
            .filter((t) => t.tool.trim() !== '')
            .map((t) => ({
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
          // 复用流中已建的 pending 卡（无则现挂）：reportProgress 实时更新标题（长任务进度）
          const callIdx = callCardIdx.get(tc.callID) ?? append({ type: 'tool-call', tool: tc.tool, callID: tc.callID, input: tc.input, state: 'running' });
          if (tc.parseError) {
            resultContent = `工具调用参数解析失败：${tc.parseError}`;
            ok = false;
          } else if (!def || INTERNAL_TOOLS.includes(tc.tool)) {
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
                  gateway: this.gateway,
                  signal,
                  tempDir: this.opts.attachmentsDir,
                  builtinSkillsDir: this.opts.builtinSkillsDir,
                  ...(agentOpts?.skills ? { allowedSkills: agentOpts.skills } : {}),
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
          if (tc.tool.trim() !== '') messages.push({ role: 'tool', content: resultContent, toolCallId: tc.callID });
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

    // 中断时把仍处于 pending/running 的 tool-call 补成 error 结果，保证当前消息与后续请求一致
    const completeInterruptedTools = (messageId: string, parts: MessagePart[]): void => {
      const running = parts.filter(
        (p): p is Extract<MessagePart, { type: 'tool-call' }> =>
          p.type === 'tool-call' && (p.state === 'running' || p.state === 'pending'),
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
    // 基准目标：会话启动时的模型（运行中切换模型后，每轮循环会重新解析，失败则回退到本目标）
    let baseTarget: ResolvedChat;
    try {
      baseTarget = this.gateway.resolveChat(settings, session.modelId);
    } catch (e) {
      const id = nextId('a');
      await appendError(id, [], Date.now(), String((e as Error)?.message ?? e));
      this.aborts.delete(sessionId);
      return;
    }
    const agent = settings.agents.find((a) => a.id === session.agentId);

    const registry = this.opts.registry ?? createDefaultRegistry();
    const disabled = new Set<string>();
    // 步数未设置（留空）= 不限步数（与设置界面"留空=不限"一致）；显式填写 >0 数字才生效
    const maxSteps = agent?.steps && agent.steps > 0 ? agent.steps : Number.POSITIVE_INFINITY;
    const cwd = session.cwd || homedir();
    const envBlock = await this.buildEnvBlock(cwd, agent, settings);

    let providerUsage: Usage | undefined;
    let lastAssistantId: string | null = null;
    let lastParts: MessagePart[] = [];
    // doom-loop：同工具同参连续 3 次 → 询问
    let lastCallSig = '';
    let doomCount = 0;
    // 步数耗尽标记：仅当显式设置了最大步数并跑满时为 true（留空=不限，永不触发）
    let stepsExhausted = false;
    // 用户拒绝标记：权限/提问被拒后终止本轮（对齐 opencode；continueLoopOnDeny=true 可保留旧行为）
    let denyStopReason = '';
    // 连续"全无效工具调用"轮数（未知工具/参数解析失败）：≥3 终止并提示，防无限空转
    let invalidTurns = 0;
    // 自动压缩 run 级熔断：失败一次即停止后续轮尝试（错误可见一次，交用户处置），防每轮反复烧失败的摘要调用
    let autoCompactGaveUp = false;
    // 上一轮生效的 agent id（检测 plan→build 切换，供切换提醒一次性注入）
    let prevAgentId = agent?.id;

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
        // 每轮重新解析模型（支持运行中切换模型：下一轮立即生效；解析失败回退到基准目标）
        const turnTarget = this.gateway.resolveChatOrNull(settings, current?.modelId ?? '') ?? baseTarget;
        
        const turnThinking = current?.thinkingMode ?? session.thinkingMode;
        // MCP 工具并入：按 agent 生效服务器名单（全开=全局 enabled 且非 off；受限=点名 on）
        const mcpTools = await this.mcpToolsFor(cwd, turnAgent, disabled);
        const tools = baseTools.concat(mcpTools);
        const mcpNote = mcpNoteOf(mcpTools);
        const canTool = turnTarget.toolcall;
        // 逐轮提醒（P0-1）：模式约束/计划锚定/todo 进度/步数预警；prevAgentId 在本轮请求组装后才更新
        const turnReminder = buildTurnReminder({
          agentId: turnAgent?.id,
          prevAgentId,
          todos: this.todos.get(sessionId) ?? [],
          turn,
          maxSteps,
          lastPlan: this.lastPlans.get(sessionId),
        });
        // 上下文压缩：占用估算（锚点+增量，见 compaction.estimateContextUsed）→ 摘要 checkpoint →
        // 仍超限丢最旧直到装得下；contextLimit<=0 / auto=false 时 token 触发跳过；工具输出持续 prune（请求侧，DB 不动）
        const compactUsable = this.compactionUsable(turnTarget.contextLimit, settings, turnTarget.maxOutput);
        const window0 = this.historyWindow(sessionId);
        let history = pruneHistory(window0.messages);
        // 工具 schema 随请求发送并计入窗口（消息估算不含它）；请求侧统一复用同一份序列化
        const toolsSchema = canTool && tools.length > 0 ? registry.toOpenAI(tools) : undefined;
        const toolsTokens = estimateToolsTokens(toolsSchema);
        const rebuild = (h: ChatMessage[]): number => {
          requestMessages = buildRequestMessages(h, composeSystemPrompt(turnAgent), envBlock + mcpNote, turnTarget.vision, turnReminder);
          return estimateContextUsed(h, estimateRequestTokens(requestMessages) + toolsTokens);
        };
        let requestMessages = buildRequestMessages(history, composeSystemPrompt(turnAgent), envBlock + mcpNote, turnTarget.vision, turnReminder);
        let est = estimateContextUsed(history, estimateRequestTokens(requestMessages) + toolsTokens);
        // 窗口饱和（条数超加载上限且窗内无 checkpoint，再往外的历史会被静默截断）触发压缩：
        // 需占用同时达到门槛（≥ usable×0.5；contextLimit 未知时退化为 50k）——低占比不再仅因条数全窗压缩
        const saturationGate = compactUsable !== null ? est >= compactUsable * SATURATION_COMPACT_RATIO : est >= 50_000;
        const saturationCompact = window0.saturated && settings.general.compaction.auto && saturationGate;
        // 需要压缩但因失败没压成的错误（自动压缩失败时插入可见 error part，不再静默）
        let autoCompactError: string | undefined;
        if (((compactUsable !== null && est >= compactUsable) || saturationCompact) && !autoCompactGaveUp) {
          // 统一走 executeCompaction（时间线流式显示）；单飞冲突（同会话已有压缩任务）→ 静默跳过，下轮复查
          if (!this.compactingSessions.has(sessionId)) {
            // 饱和触发的压缩不依赖 token 预算：usable 传极大值（尾部预算钳到 15k + 条数上限 200）
            const compactResult = await this.executeCompaction({
              sessionId,
              settings,
              target: turnTarget,
              signal,
              history,
              usable: compactUsable ?? Number.MAX_SAFE_INTEGER,
              thinking: turnThinking,
            });
            if (!compactResult.compacted && compactResult.error && compactResult.error !== COMPACTION_BUSY) {
              autoCompactError = compactResult.error;
              // run 级熔断：失败一次停止后续轮尝试（错误可见一次，防每轮反复烧失败的摘要调用）
              autoCompactGaveUp = true;
            }
          }
          if (!autoCompactError) {
            // 压缩成功（或单飞冲突跳过）：按新窗口重算占用
            est = rebuild(pruneHistory(this.historyWindow(sessionId).messages));
          }
          // 仍超限（压缩失败/无摘要可压/尾部+工具超预算）：机械降级——循环丢最旧非 checkpoint 消息
          // （保留 checkpoint 与最新两条；≤64 轮防 O(n²) 病态），本轮请求尽量合规发出；真溢出仍走下方自愈/错误终局
          for (let guard = 0; compactUsable !== null && est >= compactUsable && guard < 64; guard++) {
            const start = this.lastCompactionIndex(history) === 0 ? 1 : 0;
            if (history.length - start <= 2) break;
            const dropped = history.slice(0, start).concat(history.slice(start + 1));
            if (dropped.length === history.length) break; // 只剩 checkpoint，无可丢
            history = dropped;
            est = rebuild(history);
          }
        }
        prevAgentId = turnAgent?.id ?? prevAgentId;
        // 上下文仪表：与触发判定同一口径（锚点 usageTotal + 增量；触发线已按 usable 预留输出预算）
        this.emit({ sessionId, type: 'session.context', used: est, limit: turnTarget.contextLimit });
        let request: ChatReq = {
          messages: requestMessages,
          thinking: turnThinking,
          maxTokens: turnTarget.maxOutput > 0 ? turnTarget.maxOutput : undefined,
          signal,
          options: turnTarget.options,
          ...(toolsSchema ? { tools: toolsSchema } : {}),
        };

        const assistantId = nextId('a');
        const createdAt = Date.now();
        const parts: MessagePart[] = [];
        storage.insertMessage({ id: assistantId, sessionId, role: 'assistant', parts: [], createdAt });
        lastAssistantId = assistantId;
        lastParts = parts;

        // 自动压缩失败的可见提示（error part 不终止循环；若请求随后真溢出，还会走压缩自愈重试）
        if (autoCompactError) {
          const idx = parts.length;
          parts.push({ type: 'error', message: `上下文自动压缩失败：${autoCompactError}` });
          emitPart(assistantId, idx, parts[idx]!, true);
          storage.updateMessageParts(assistantId, parts);
        }

        let reasoningAcc = '';
        let textAcc = '';
        // part 索引 append-only 分配：text/reasoning 槽位不再写死 0/1，流中插入 pending 工具卡不会被覆盖
        let reasoningIdx = -1;
        let textIdx = -1;
        // 思考起止时间（渲染层折叠"已思考 · Ns"；start=首个 delta，end=首个正文/工具或流结束）
        let reasoningStart = 0;
        let reasoningClosed = false;
        const closeReasoningTime = (): void => {
          if (reasoningIdx < 0 || reasoningClosed) return;
          reasoningClosed = true;
          const p = parts[reasoningIdx];
          if (p && p.type === 'reasoning') parts[reasoningIdx] = { ...p, time: { start: p.time?.start || reasoningStart || Date.now(), end: Date.now() } };
        };
        // callID → 工具卡 part 下标（流中 start 建卡，complete 事件按 callID upsert，避免重复卡片）
        const toolPartIdx = new Map<string, number>();
        const turnToolCalls: { callID: string; tool: string; input: unknown; parseError?: string }[] = [];
        let streamError: LLMError | undefined;

        // 流式 delta 落库节流（200ms）：高频 delta 只发事件不逐条写 DB，结束时由 finalizeMessage 兜底
        let lastPersistAt = 0;
        const persistPartsThrottled = (): void => {
          const now = Date.now();
          if (now - lastPersistAt < 200) return;
          lastPersistAt = now;
          storage.updateMessageParts(assistantId, parts);
        };

        // 消费一轮 LLM 流（抽出以便重试复用；累积器/索引跨重试保留，由 resetForRetry 清理）
        const consumeStream = async (req: ChatReq): Promise<void> => {
          const stream = this.engineFor(turnTarget).stream(turnTarget.binding, req);
          try {
            for await (const ev of stream) {
              switch (ev.type) {
                case 'reasoning-delta': {
                  reasoningAcc += stripThinkTags(ev.text);
                  if (!reasoningStart) reasoningStart = Date.now();
                  if (reasoningIdx < 0) {
                    reasoningIdx = parts.length;
                    parts.push({ type: 'reasoning', text: reasoningAcc, time: { start: reasoningStart } });
                  } else {
                    const prevEnd = (parts[reasoningIdx] as Extract<MessagePart, { type: 'reasoning' }>).time?.end;
                    parts[reasoningIdx] = { type: 'reasoning', text: reasoningAcc, time: { start: reasoningStart, ...(prevEnd ? { end: prevEnd } : {}) } };
                  }
                  emitPart(assistantId, reasoningIdx, parts[reasoningIdx]!);
                  persistPartsThrottled();
                  break;
                }
                case 'text-delta': {
                  closeReasoningTime();
                  textAcc += ev.text;
                  if (textIdx < 0) {
                    textIdx = parts.length;
                    parts.push({ type: 'text', text: textAcc });
                  } else {
                    parts[textIdx] = { type: 'text', text: textAcc };
                  }
                  emitPart(assistantId, textIdx, parts[textIdx]!);
                  persistPartsThrottled();
                  break;
                }
                case 'tool-call-start': {
                  closeReasoningTime();
                  // 流中即建卡（pending）：模型一开始发工具调用就立即可见，不再等整条流结束
                  if (!ev.callID || toolPartIdx.has(ev.callID)) break;
                  const idx = parts.length;
                  parts.push({ type: 'tool-call', tool: ev.tool, callID: ev.callID, input: {}, state: 'pending' });
                  toolPartIdx.set(ev.callID, idx);
                  emitPart(assistantId, idx, parts[idx]!);
                  persistPartsThrottled();
                  break;
                }
                case 'tool-call-delta':
                  // 参数增量不逐条广播（pending 卡已可见，参数完整时由 tool-call 一次性更新）
                  break;
                case 'tool-call': {
                  closeReasoningTime();
                  turnToolCalls.push({ callID: ev.callID, tool: ev.tool, input: ev.input, ...(ev.parseError ? { parseError: ev.parseError } : {}) });
                  const part: MessagePart = { type: 'tool-call', tool: ev.tool, callID: ev.callID, input: ev.input, state: 'running' };
                  const existing = toolPartIdx.get(ev.callID);
                  if (existing !== undefined) {
                    parts[existing] = part;
                    emitPart(assistantId, existing, part);
                  } else {
                    const idx = parts.length;
                    parts.push(part);
                    toolPartIdx.set(ev.callID, idx);
                    emitPart(assistantId, idx, part);
                  }
                  persistPartsThrottled();
                  break;
                }
                case 'finish':
                  closeReasoningTime();
                  if (ev.usage) {
                    providerUsage = ev.usage;
                    // 逐轮落库：本轮真实 usage 写到本轮 assistant 消息（压缩锚点 + 上下文占用共用此口径）
                    storage.updateMessageTokens(assistantId, ev.usage);
                    // 逐轮落库+广播：Token 统计随每次 LLM 请求实时刷新，不再等整轮结束
                    this.reportUsage(sessionId, turnTarget.modelId, ev.usage);
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
        };

        await consumeStream(request);

        // ---- 循环级重试 / 溢出自愈（对齐 opencode：可重试错误退避重发，溢出先压缩再重试）----
        const RETRY_MAX_ATTEMPTS = 3; // 总发送次数上限（含首次；重试事件显示 2/3、3/3）
        let attempt = 1;
        let compactedForOverflow = false;
        while (streamError && !signal.aborted) {
          if (streamError.kind === 'context_overflow' && !compactedForOverflow) {
            // 溢出自愈：压缩后重建请求重试本轮（不占用重试次数；仅自愈一次）。
            // 统一走 executeCompaction（时间线流式显示）；单飞冲突时视为无法压缩
            compactedForOverflow = true;
            const res = await this.executeCompaction({
              sessionId,
              settings,
              target: turnTarget,
              signal,
              history: pruneHistory(this.historyWindow(sessionId).messages),
              usable: compactUsable ?? Number.MAX_SAFE_INTEGER,
              thinking: turnThinking,
            });
            if (!res.compacted) break; // 无法压缩（含已在压缩中）→ 走错误终局
            est = rebuild(pruneHistory(this.historyWindow(sessionId).messages));
            this.emit({ sessionId, type: 'session.context', used: est, limit: turnTarget.contextLimit });
            request = { ...request, messages: requestMessages };
          } else if (!streamError.retryable || attempt >= RETRY_MAX_ATTEMPTS) {
            break; // 不可重试（auth/quota/invalid）或重试耗尽 → 错误终局
          } else {
            const delayMs = Math.max(streamError.retryAfterMs ?? 0, Math.min(2000 * 2 ** (attempt - 1), 30_000));
            attempt += 1;
            this.emit({ sessionId, type: 'session.retry', attempt, maxAttempts: RETRY_MAX_ATTEMPTS, delayMs, message: friendlyLLMMessage(streamError) });
            await new Promise<void>((resolve) => {
              const onAbort = (): void => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve();
              };
              const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
              }, delayMs);
              signal.addEventListener('abort', onAbort, { once: true });
            });
            if (signal.aborted) break;
          }
          // 重试前清理：半截文本清空（重发会从头生成，保留旧片段会出现断句+重复）；
          // pending/running 卡标记为 error 但不追加结果——重试若复用同一 callID 则该卡复活并正常配对，
          // 未复用时缺失结果由请求构建兜底合成「未执行/已中断」（appendInterrupted 会造成重复 result 配对）
          if (reasoningIdx >= 0 && parts[reasoningIdx]) {
            parts[reasoningIdx] = { type: 'reasoning', text: '' };
            emitPart(assistantId, reasoningIdx, parts[reasoningIdx]!, true);
          }
          if (textIdx >= 0 && parts[textIdx]) {
            parts[textIdx] = { type: 'text', text: '' };
            emitPart(assistantId, textIdx, parts[textIdx]!, true);
          }
          reasoningAcc = '';
          textAcc = '';
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i]!;
            if (p.type === 'tool-call' && (p.state === 'pending' || p.state === 'running')) {
              parts[i] = { ...p, state: 'error' };
              emitPart(assistantId, i, parts[i]!, true);
            }
          }
          storage.updateMessageParts(assistantId, parts);
          turnToolCalls.length = 0;
          streamError = undefined;
          await consumeStream(request);
        }

        if (signal.aborted) {
          if (reasoningAcc && reasoningIdx >= 0 && parts[reasoningIdx]) emitPart(assistantId, reasoningIdx, parts[reasoningIdx]!, true);
          if (textAcc && textIdx >= 0 && parts[textIdx]) emitPart(assistantId, textIdx, parts[textIdx]!, true);
          completeInterruptedTools(assistantId, parts);
          break;
        }
        if (streamError) {
          completeInterruptedTools(assistantId, parts);
          await appendError(assistantId, parts, createdAt, friendlyLLMMessage(streamError), providerUsage);
          break;
        }

        if (reasoningAcc && reasoningIdx >= 0 && parts[reasoningIdx]) emitPart(assistantId, reasoningIdx, parts[reasoningIdx]!, true);
        if (textAcc && textIdx >= 0 && parts[textIdx]) emitPart(assistantId, textIdx, parts[textIdx]!, true);

        // 工具调用：执行后继续下一轮（不依赖 finish_reason：部分平台 stop 也携带工具调用，对齐 opencode）
        if (turnToolCalls.length > 0) {
          let hadValid = false;
          for (const tc of turnToolCalls) {
            if (signal.aborted) break;
            // MCP 工具不在注册表：从本轮并入的 mcpTools 中查找
            const def = registry.get(tc.tool) ?? (tc.tool.startsWith('mcp_') ? mcpTools.find((t) => t.id === tc.tool) : undefined);
            // 未知/空工具/参数解析失败：不询问权限，直接错误结果（避免挂起"执行中"）；
            // 错误结果回传模型自我纠正（不再因 !hadValid 直接终止 loop）
            if (tc.parseError || !def) {
              const reason = tc.parseError
                ? `工具调用参数解析失败：${tc.parseError}`
                : tc.tool
                  ? `未知工具：${tc.tool}`
                  : '模型返回了空的工具调用';
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
                error: reason,
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
              if (!settings.general.continueLoopOnDeny) denyStopReason = '你拒绝了本次操作请求';
            } else {
              try {
                const output = await def.execute(tc.input as Record<string, unknown>, {
                  sessionId,
                  cwd,
                  settings,
                  gateway: this.gateway,
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
                  savePlan: (plan) => {
                    this.lastPlans.set(sessionId, plan);
                  },
                  lastPlan: () => this.lastPlans.get(sessionId),
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
                   // 富输出：图片/文件/markdown 追加为独立 part（消息流直接呈现），模型只收文本
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
                   if (output.markdown) {
                     const idx = parts.length;
                     parts[idx] = { type: 'text', text: output.markdown.text, synthetic: true };
                     emitPart(assistantId, idx, parts[idx]!, true);
                     storage.updateMessageParts(assistantId, parts);
                   }
                   result = { output: output.text };
                 } else {
                   result = { output };
                 }
              } catch (e) {
                if (e instanceof UserRejectedError) {
                  result = { error: e.message };
                  if (!settings.general.continueLoopOnDeny) denyStopReason = e.message;
                } else {
                  result = { error: String((e as Error)?.message ?? e) };
                }
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
          // 用户拒绝：终止本轮，不再发起下一次请求（工具结果已落库，配对完整）
          if (denyStopReason) break;
          // 本轮全部为无效工具调用：错误结果已回传，模型可在下一轮纠正；
          // 连续多轮全无效才终止（防未知工具死循环空转），并给可见提示
          if (!hadValid) {
            invalidTurns += 1;
            if (invalidTurns >= 3) {
              const idx = parts.length;
              parts[idx] = { type: 'text', text: '连续多轮工具调用无效（未知工具或参数异常），本轮到此停止。请检查工具配置或换用其他方式后重试。' };
              emitPart(assistantId, idx, parts[idx]!, true);
              storage.updateMessageParts(assistantId, parts);
              break;
            }
            continue;
          }
          invalidTurns = 0;
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

    // 用户拒绝后终止：给用户可见提示，避免"无声停止"
    if (denyStopReason && lastAssistantId && !finalized) {
      const idx = lastParts.length;
      lastParts[idx] = { type: 'text', text: `${denyStopReason}，本轮到此停止。补充说明后直接发送即可继续。` };
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
        ([...msgs]
          .reverse()
          .find((m) => m.role === 'assistant')
          ?.parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text' && !p.synthetic)
          .map((p) => p.text)
          .join(' ') ?? '').slice(0, 400);
      if (!userText.trim() || !assistantText.trim()) return;
      const title = await this.generateTitle(sessionId, session, settings, userText, assistantText);
      if (!title) return;
      storage.patchSession(sessionId, { title }, Date.now(), 'auto');
      this.emit({ sessionId, type: 'session.updated', meta: { ...storage.getSession(sessionId)! } });
    } catch {
      // 标题生成失败静默保留现有标题
    }
  }

  /** 用会话模型生成标题（单次对话，走 chatEngineImpl 便于测试注入） */
  private async generateTitle(
    sessionId: string,
    session: SessionMeta,
    settings: Settings,
    userText: string,
    assistantText: string,
  ): Promise<string | null> {
    try {
      const target = this.gateway.resolveChatOrNull(settings, session.modelId);
      if (!target) return null;
      const request: ChatReq = {
        messages: [
          {
            role: 'system',
            content: '根据下面的对话开头生成一个不超过20个字的会话标题。直接输出标题本身，不要引号、句号或任何说明。',
          },
          { role: 'user', content: `用户：${userText}\n\n助手：${assistantText}` },
        ],
        thinking: 'off',
        maxTokens: 64,
      };
      const stream = this.engineFor(target).stream(target.binding, request);
      let text = '';
      let reasoning = '';
      for await (const ev of stream) {
        if (ev.type === 'text-delta') text += ev.text;
        else if (ev.type === 'reasoning-delta') reasoning += ev.text;
        // 标题调用成本入账；thinking-only 模型正文空时回退取思考流首行
        if (ev.type === 'finish' && ev.usage) this.reportUsage(sessionId, target.modelId, ev.usage);
      }
      const source = text.trim() || stripThinkTags(reasoning).split('\n')[0] || '';
      const cleaned = source
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
   * 逐轮用量上报：落库 + 广播累计总量（session.usage，"Token 消耗"块实时刷新）。
   * 上下文占用改由 runLoop/finalize/compact 的 session.context 发射点推送（权威口径含 system prompt 与 limit）。
   */
  private reportUsage(sessionId: string, modelId: string, usage: Usage): void {
    const storage = this.opts.db.storage;
    storage.appendUsage(sessionId, modelId, usage);
    const total = storage.getUsage(sessionId);
    if (total) this.emit({ sessionId, type: 'session.usage', usage: total });
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
    // synthetic text（如 plan 可见计划全文）非模型生成输出，不计入用量估算
    const outText = parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text' && !p.synthetic).map((p) => p.text).join('');
    const reasoningText = parts.filter((p): p is Extract<MessagePart, { type: 'reasoning' }> => p.type === 'reasoning').map((p) => p.text).join('');
    const usage: Usage =
      providerUsage ??
      ({
        inputTokens: estimateTokens(outText + reasoningText),
        outputTokens: estimateTokens(outText),
        reasoningTokens: estimateTokens(reasoningText),
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
    // 上下文仪表：与 runLoop/computeContext 统一口径（锚点 + 增量；有本轮 provider usage 即锚定本轮，含 system/tools/前文）
    try {
      const ctx = await this.computeContext(sessionId);
      if (ctx) this.emit({ sessionId, type: 'session.context', ...ctx });
    } catch {
      // 上下文推送失败不影响落库
    }
    this.emit({ sessionId, type: 'message.complete', messageId, message });
    this.emit({ sessionId, type: 'session.status', status: 'idle' });
  }
}
