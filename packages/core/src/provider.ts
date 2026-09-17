/**
 * Provider 契约 —— 渲染层唯一依赖的接口（决策 #25）。
 * real 实现：desktop preload（Electron IPC）；mock 实现：renderer MockProvider（浏览器直跑）。
 * 本文件仅类型 + 纯函数，不依赖 Node / Electron。
 */

export type SessionMode = 'chat' | 'script';
export type ThinkingMode = 'off' | 'on' | 'deep';
export type SessionStatus = 'idle' | 'running' | 'queued';
export type Role = 'user' | 'assistant';

export interface SessionMeta {
  id: string;
  title: string;
  mode: SessionMode;
  agentId: string;
  cwd: string;
  modelId: string;
  thinkingMode: ThinkingMode;
  status: SessionStatus;
  /** 联网开关：false=禁用 webfetch/websearch（含 task 子代理）；缺省 = 开 */
  webAccess?: boolean;
  /** 标题来源：auto=可被自动生成更新；user=用户已自定义，锁定（历史会话视为 user） */
  titleSource?: 'auto' | 'user';
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionInput {
  title?: string;
  mode?: SessionMode;
  agentId?: string;
  cwd?: string;
  modelId?: string;
  thinkingMode?: ThinkingMode;
}

export type SessionPatch = Partial<
  Pick<SessionMeta, 'title' | 'mode' | 'agentId' | 'modelId' | 'thinkingMode' | 'webAccess'>
>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/** 当前会话的上下文占用（主进程权威口径：est = max(请求估算, 上次真实 usage)） */
export interface SessionContext {
  /** 下一次请求的上下文规模（token） */
  used: number;
  /** 模型 contextLimit（0 = 未知/不限制） */
  limit: number;
}

export type MessagePart =
  | { type: 'text'; text: string; /** 仅展示不进请求（如 plan 工具的可见计划全文）；buildRequestMessages 跳过 */ synthetic?: boolean }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; dataUrl: string; name?: string }
  | {
      type: 'tool-call';
      tool: string;
      callID: string;
      input: unknown;
      /** pending=流式中参数未齐（立即出卡）；running=参数齐/执行中 */
      state: 'pending' | 'running' | 'completed' | 'error';
      title?: string;
    }
  | { type: 'tool-result'; callID: string; output: unknown; state: 'completed' | 'error'; error?: string }
  | { type: 'error'; message: string }
  | {
      type: 'compaction';
      summary: string;
      /** 语义边界：此摘要覆盖到该时间戳为止（该时刻之后的原文仍进请求窗口）。
       * 缺省（旧格式 checkpoint）= 按消息定位切窗；显示位置 createdAt = 压缩完成时刻（时间线底部） */
      coversBefore?: number;
    }
  | { type: 'file'; name: string; kind: string; path: string };

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: Role;
  parts: MessagePart[];
  tokens?: Usage;
  cost?: number;
  createdAt: number;
}

/** 反向分页：beforeId 之前的 limit 条（按时间升序返回） */
export interface PageQuery {
  beforeId?: string;
  limit?: number;
}

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  /** 本页最旧一条的 id，用于继续向上翻页 */
  beforeId?: string;
}

export interface SendMessageInput {
  text: string;
  attachmentIds?: string[];
}

export interface PermissionRequest {
  id: string;
  tool: string;
  args: unknown;
  targetPath?: string;
  callID?: string;
  messageId?: string;
}

export type PermissionDecision = 'allow' | 'deny' | 'allowAlways';

/** 模型向用户提问（question 工具）：待用户通过界面回答 */
export interface QuestionRequest {
  id: string;
  question: string;
  options?: string[];
}

/** 任务清单条目（todo 工具） */
export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type SessionEvent =
  | { sessionId: string; type: 'message.part.delta'; messageId: string; partIndex: number; part: MessagePart }
  | { sessionId: string; type: 'message.part.done'; messageId: string; partIndex: number; part: MessagePart }
  | { sessionId: string; type: 'message.complete'; messageId: string; message: ChatMessage }
  | { sessionId: string; type: 'session.status'; status: SessionStatus }
  | { sessionId: string; type: 'session.usage'; usage: Usage }
  | { sessionId: string; type: 'permission.request'; request: PermissionRequest }
  | { sessionId: string; type: 'session.question'; request: QuestionRequest }
  | { sessionId: string; type: 'session.todo'; todos: TodoItem[] }
  | { sessionId: string; type: 'session.compacted'; message: ChatMessage }
  /** 压缩进行中（自动/手动共用信号；摘要是一次 LLM 调用，需数秒）。
   * messageId = 流式占位块/最终 checkpoint 的消息 id（渲染层跨会话追踪与失败清理用） */
  | { sessionId: string; type: 'session.compacting'; active: boolean; messageId?: string }
  /** 循环级重试：可重试错误（429/网络/5xx）退避后重发本轮请求 */
  | { sessionId: string; type: 'session.retry'; attempt: number; maxAttempts: number; delayMs: number; message: string }
  /** 上下文仪表：下一次请求的规模（max(请求估算, 上次真实 usage)）+ 模型窗口；主进程权威口径 */
  | { sessionId: string; type: 'session.context'; used: number; limit: number }
  | { sessionId: string; type: 'session.updated'; meta: SessionMeta };

export interface AgentProvider {
  listSessions(): Promise<SessionMeta[]>;
  createSession(input: CreateSessionInput): Promise<SessionMeta>;
  patchSession(id: string, patch: SessionPatch): Promise<SessionMeta>;
  deleteSession(id: string): Promise<void>;
  getMessages(sessionId: string, opts: PageQuery): Promise<MessagePage>;
  sendMessage(sessionId: string, input: SendMessageInput): Promise<ChatMessage>;
  stopSession(sessionId: string): Promise<void>;
  /** 手动压缩上下文：旧历史折叠为摘要 checkpoint（非破坏，旧消息保留）；返回是否实际压缩 */
  compactSession(sessionId: string): Promise<boolean>;
  /** 当前上下文占用（切换会话时初始拉取；此后由 session.context 事件推送） */
  getSessionContext(sessionId: string): Promise<SessionContext | null>;
  /** 订阅流式事件，返回取消订阅函数 */
  onEvent(cb: (ev: SessionEvent) => void): () => void;
  resolvePermission(request: PermissionRequest, decision: PermissionDecision): Promise<void>;
  /** 会话累计 token 消耗（统计用） */
  getUsage(sessionId: string): Promise<Usage | null>;
  /** 上传会话临时附件（主进程写 temp 并登记） */
  uploadAttachment(sessionId: string, upload: AttachmentUpload): Promise<Attachment>;
  /** 设置读取/更新（决策 10：最终落 JSON 配置，本契约保持稳定） */
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
}

// ---- 附件（I6a） ----

export interface AttachmentUpload {
  name: string;
  mime?: string;
  size: number;
  /** base64 编码的文件内容 */
  dataBase64: string;
}

export interface Attachment {
  id: string;
  sessionId: string;
  messageId?: string;
  name: string;
  /** txt/md/docx/xlsx/pptx/pdf/image/other */
  kind: string;
  size: number;
  storedPath: string;
  inline: boolean;
  createdAt: number;
}

// ---- Settings（决策 5 / 10） ----

export type Capability =
  | 'chat'
  | 'embedding'
  | 'rerank'
  | 'image-understanding'
  | 'tts'
  | 'asr'
  | 'image-generation'
  | 'video-generation';

export const CAPABILITIES: Capability[] = [
  'chat',
  'embedding',
  'rerank',
  'image-understanding',
  'tts',
  'asr',
  'image-generation',
  'video-generation',
];

/** 多模态/专用能力（非 chat；配置在 multimodalModels 区） */
export type MultimodalCapability = Exclude<Capability, 'chat'>;

export const MULTIMODAL_CAPABILITIES: MultimodalCapability[] = [
  'embedding',
  'rerank',
  'image-understanding',
  'tts',
  'asr',
  'image-generation',
  'video-generation',
];

/**
 * 对话接口实现 id（llm/engines/chat/*，与 CHAT_ENGINES 注册表一一对应）。
 * 每家 provider（含不同 API 版本）一个独立实现；'openai-compatible' 为兼容兜底。
 */
export type ChatImplId = 'deepseek' | 'siliconflow' | 'agnes' | 'bigmodel' | 'qwen' | 'openrouter' | 'openai-compatible';

/**
 * 多模态接口实现 id（llm/engines/*，与 MM_ENGINES 注册表对应）。
 * 单模型粒度各自选择实现；OpenAI 兼容系列为兜底。
 * image-understanding 模型的请求本质是对话协议，因此可用 chat 类实现。
 */
export type MMImplId =
  | ChatImplId
  | 'agnes-video-v2.0'
  | 'agnes-video-2.5'
  | 'siliconflow-video'
  | 'agnes-image'
  | 'openai-image'
  | 'openai-embed'
  | 'openai-rerank'
  | 'openai-tts'
  | 'openai-asr';

/** 对话模型（自包含：接口实现 + 地址 + Key + 模型名） */
export interface ChatModelConfig {
  id: string;
  displayName: string;
  /** 使用哪家的接口实现（见 ChatImplId；engines/catalog.ts 提供默认地址等元数据） */
  implId: ChatImplId;
  /** API 地址（添加时按实现预填默认值，可改） */
  baseUrl: string;
  /** 掩码展示；明文仅存在于持久化层 */
  apiKey: string;
  /** 请求体 model 参数 */
  modelName: string;
  contextLimit: number;
  maxOutput: number;
  enabled: boolean;
  /** 是否支持 function-call；false 时不注入 tools */
  toolcall: boolean;
  /** 是否支持视觉输入；false 时图片附件降级为文件引用 */
  vision: boolean;
  /** 透传给接口实现的额外请求体参数 */
  options?: Record<string, unknown>;
}

/** 多模态/专用模型（自包含，独立于对话模型区；每个模型单独选择接口实现） */
export interface MultimodalModelConfig {
  id: string;
  displayName: string;
  capability: MultimodalCapability;
  implId: MMImplId;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  /** 透传给接口实现的额外参数 */
  options?: Record<string, unknown>;
  enabled: boolean;
}

export interface CapabilityBinding {
  capability: Capability;
  modelId: string;
}

export interface PermissionRule {
  tool: string;
  mode: 'allow' | 'deny' | 'ask';
  /** 是否启用（注入上下文）；缺省 = 默认策略的 enabled（矩阵：仅偏离时存） */
  enabled?: boolean;
}

export interface ToolOverride {
  /** on/off 明确开关；缺省 = 跟随全局 enabled */
  load?: boolean;
  /** allow/deny/ask 显式覆盖；缺省 = 跟随全局/默认策略 mode */
  mode?: 'allow' | 'deny' | 'ask';
}

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /**
   * 工具矩阵（I13.1）：per-tool 偏离记录（缺省工具 = 跟随全局 enabled/mode）。
   * 遗留字段 tools（白名单）/ permission.* 仅在无 toolOverrides 时按旧语义解释，
   * UI 首次编辑前调用 materializeAgentMatrix 物化。
   */
  tools: string[];
  permission: { allow: string[]; deny: string[]; ask: string[] };
  toolOverrides?: Record<string, ToolOverride>;
  /** MCP 服务器偏离项：'on'=强制开启（覆盖全局关）、'off'=对该 agent 排除；未列出 = 继承全局 */
  mcp?: Record<string, 'on' | 'off'>;
  /** 技能逐条偏离：'on'=强制进上下文（覆盖全局关）、'off'=对该 agent 移出 available_skills；未列出 = 跟随全局 */
  skillOverrides?: Record<string, 'on' | 'off'>;
  steps?: number;
  modelId?: string;
  builtin?: boolean;
}

export interface GeneralSettings {
  language: 'zh-CN' | 'en-US';
  theme: 'light' | 'dark' | 'system';
  maxConcurrency: number;
  /** 会话标题自动生成的轮数上限（前 N 轮可自动更新；0=关闭；用户手动编辑即永久锁定） */
  titleAutoRounds: number;
  /** 用户拒绝权限/提问后是否继续 agent loop（对齐 opencode：默认 false = 拒绝即停止本轮） */
  continueLoopOnDeny?: boolean;
  /** 网页搜索（决策 17）：启用引擎（按固定优先级过滤）与结果条数 */
  websearch: {
    engines: string[];
    maxResults: number;
  };
  compaction: {
    auto: boolean;
    reservedTokens: number;
    preserveRatio: number;
    /** 摘要专用模型 id（留空=用会话当前模型；可选便宜快速的模型降低压缩成本） */
    modelId?: string;
  };
  /** 全局关闭的技能名列表（I13，存设置而非技能文件；跨层同名技能一并隐藏） */
  disabledSkills?: string[];
  /** 脚本会话单次运行超时（分钟）：0/缺省 = 不限；>0 到期 kill 子进程（I14.1） */
  scriptTimeoutMinutes?: number;
  /** 打开会话时初始加载的历史消息条数（5–50） */
  chatInitialMessages?: number;
  /** 向上滚动加载历史时每页条数（10–100）；内存窗口（6 页/保留 5 页）随本值派生 */
  chatPageMessages?: number;
}

export interface Settings {
  chatModels: ChatModelConfig[];
  multimodalModels: MultimodalModelConfig[];
  bindings: CapabilityBinding[];
  agents: AgentDef[];
  permissions: { default: PermissionRule[] };
  general: GeneralSettings;
}

/** 渲染层注入的 Provider 实例（real 或 mock） */
export const PROVIDER: { current: AgentProvider | null } = { current: null };

export function setProvider(p: AgentProvider | null): void {
  PROVIDER.current = p;
}

export function getProvider(): AgentProvider {
  if (!PROVIDER.current) {
    throw new Error('AgentProvider 未初始化（开发模式请先注入 MockProvider）');
  }
  return PROVIDER.current;
}

export function formatUsage(usage: Usage): string {
  const total = usage.inputTokens + usage.outputTokens;
  const reasoning = usage.reasoningTokens ? ` (思考 ${usage.reasoningTokens})` : '';
  const cost = usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : '';
  return `${total} tokens${reasoning}${cost}`;
}
