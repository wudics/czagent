/** 上下文压缩：token 估算 / 工具输出截断与清理（仅请求侧，DB 保留全量）。 */
import type { ChatMessage, Usage } from './provider.js';

/** 每张压缩后图片的固定 token 估算（最长边1600/JPEG85 的近似，实际随分辨率浮动） */
export const IMAGE_TOKENS = 2000;
/** 每条消息的结构开销（role/格式/换行） */
export const MESSAGE_OVERHEAD_TOKENS = 4;
/** 每个工具调用/结果条目的开销 */
export const PART_OVERHEAD_TOKENS = 2;
/** 工具结果在请求中的最大字符数（超出截断并加标记） */
export const TOOL_RESULT_TRUNCATE_CHARS = 10_000;
export const TOOL_RESULT_TRUNCATE_MARKER = '\n…（工具输出已截断，完整内容可再次读取原文件）';
/** 豁免常规截断的工具（完整说明必须进上下文，如 skill：截断会让模型拿不到完整指导且无法自行补读） */
export const FULL_RESULT_TOOLS = new Set(['skill']);
/** 豁免工具的安全上限（防病态超大文件撑爆上下文） */
export const FULL_RESULT_MAX_CHARS = 32_000;

/** prune：从最新侧起保护的工具输出 token 预算，更旧的输出请求侧替换为占位 */
export const PRUNE_PROTECT_TOKENS = 40_000;
/** prune：被清理工具输出的占位文本（tool-call 保留，DB 原文不动） */
export const PRUNE_PLACEHOLDER =
  '[旧工具输出已清理：完整内容仍在会话记录中，可用 read 工具重新读取相关文件]';
/** prune：保护最近 N 个 user turn（当前轮 + 上一轮）不参与清理 */
export const PRUNE_PROTECT_USER_TURNS = 2;

/** 保留尾部 token 预算钳制（对齐 opencode：min(15k, max(2k, usable×比例))） */
export const TAIL_BUDGET_MIN = 2_000;
export const TAIL_BUDGET_MAX = 15_000;
/** 请求窗口一次加载的最大消息数（DB 分页上限；超出即窗口截断，由压缩按占用门槛收敛） */
export const HISTORY_WINDOW_MESSAGES = 2_000;
/** 饱和强制压缩触发比例：估算 ≥ usable×该比例才允许"仅因条数超限"压缩（低占比不再无脑全窗压缩） */
export const SATURATION_COMPACT_RATIO = 0.5;
/** 保留尾部消息数上限（尾部 ≤200 留出新空间，避免压缩后立即再次逼近条数上限） */
export const TAIL_MAX_MESSAGES = 200;

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** 文本 token 估算：CJK 约 1.5 字/token，其余约 4 字符/token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

export interface EstimatedChatMessage {
  content?: string | null;
  reasoning?: string;
  images?: { dataUrl: string }[];
  toolCalls?: { name: string; arguments: string }[];
}

/** 对构建好的请求消息整体做 token 估算（含结构开销） */
export function estimateRequestTokens(messages: EstimatedChatMessage[]): number {
  let t = 0;
  for (const m of messages) {
    t += MESSAGE_OVERHEAD_TOKENS;
    if (m.content) t += estimateTokens(m.content);
    if (m.reasoning) t += estimateTokens(m.reasoning);
    for (const img of m.images ?? []) t += IMAGE_TOKENS + Math.ceil(img.dataUrl.length / 4096);
    for (const tc of m.toolCalls ?? []) {
      t += PART_OVERHEAD_TOKENS;
      t += estimateTokens(tc.name + ' ' + String(tc.arguments ?? ''));
    }
  }
  return t;
}

/** 工具输出截断：保留头部，超限加标记（仅请求侧，DB 仍存全量）；豁免工具用宽松安全上限；
 * capOverride > 0 时强制使用该上限（如摘要请求把工具输出压到 2k） */
export function truncateToolOutput(text: string, tool?: string, capOverride?: number): string {
  const cap = capOverride && capOverride > 0 ? capOverride : tool && FULL_RESULT_TOOLS.has(tool) ? FULL_RESULT_MAX_CHARS : TOOL_RESULT_TRUNCATE_CHARS;
  if (text.length <= cap) return text;
  return text.slice(0, cap) + TOOL_RESULT_TRUNCATE_MARKER;
}

/** 工具 schema 数组的 token 估算（随请求发送、参与计费与窗口占用，但不含在消息估算里） */
export function estimateToolsTokens(tools: unknown): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4) + tools.length * MESSAGE_OVERHEAD_TOKENS;
}

/**
 * provider usage 折算为"该次请求的上下文规模"：input(prompt_tokens) 已含缓存读写、
 * output(completion_tokens) 已含 reasoning（OpenAI 语义子集）——再叠子集字段会重复计
 * （DeepSeek 等命中 90%+ 时虚高 2~3 倍，导致远未到真实阈值就触发压缩）。
 * opencode 五字段互斥全加，与本式数值等价。
 */
export function usageTotal(u?: Usage): number {
  if (!u) return 0;
  return u.inputTokens + u.outputTokens;
}

/** 最后一个 compaction checkpoint 在消息数组中的下标；无则 -1 */
export function findLastCompactionIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.parts.some((p) => p.type === 'compaction')) return i;
  }
  return -1;
}

/**
 * 上下文占用统一口径（对齐 opencode estimateTokens：真实 usage 锚点 + 锚点后增量）。
 * 锚点 = 最后一个 checkpoint 之后、最近一条带真实 usage（inputTokens>0）的 assistant 消息；
 * usageTotal 覆盖构建该请求时的全部前文（system/env/tools/更早历史），锚点之后的新消息
 * （用户补充、工具结果等）用 estimateMessageTokens 累加。
 * 压缩刚完成还没有新锚点（checkpoint 之后无带 usage 的消息）→ 回退纯估算 fallback，
 * 避免拿压缩前的旧 usage 误判"仍超限"。
 */
export function estimateContextUsed(history: ChatMessage[], fallback: number): number {
  const cp = findLastCompactionIndex(history);
  for (let i = history.length - 1; i > cp; i--) {
    const m = history[i]!;
    if (m.role === 'assistant' && m.tokens && m.tokens.inputTokens > 0) {
      let after = 0;
      for (let j = i + 1; j < history.length; j++) after += estimateMessageTokens(history[j]!);
      return usageTotal(m.tokens) + after;
    }
  }
  return fallback;
}

function toolOutputText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output ?? null);
}

/** 单条历史消息的 token 估算（与请求构建口径一致：文本/推理/工具入参出参/图片固定值 + 开销） */
export function estimateMessageTokens(m: ChatMessage): number {
  let t = MESSAGE_OVERHEAD_TOKENS;
  for (const p of m.parts) {
    switch (p.type) {
      case 'text':
      case 'reasoning':
        t += estimateTokens(p.text);
        break;
      case 'compaction':
        t += estimateTokens(p.summary);
        break;
      case 'image':
        t += IMAGE_TOKENS;
        break;
      case 'tool-call':
        t += PART_OVERHEAD_TOKENS + estimateTokens(p.tool + ' ' + JSON.stringify(p.input ?? {}));
        break;
      case 'tool-result':
        t += PART_OVERHEAD_TOKENS + estimateTokens(toolOutputText(p.output));
        break;
      case 'file':
        t += PART_OVERHEAD_TOKENS + estimateTokens(`${p.name} ${p.path}`);
        break;
      case 'error':
        t += estimateTokens(p.message);
        break;
    }
  }
  return t;
}

/**
 * prune：从最新往旧扫，跳过最近 PRUNE_PROTECT_USER_TURNS 个 user turn；
 * 已完成 tool-result 按 token 从新到旧累计，超过 PRUNE_PROTECT_TOKENS 的部分
 * 请求侧替换为占位（tool-call 保留；返回新对象，不改入参/DB）。
 */
export function pruneHistory(history: ChatMessage[]): ChatMessage[] {
  const out = [...history];
  let total = 0;
  let userTurns = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === 'user') {
      userTurns += 1;
      continue;
    }
    if (userTurns < PRUNE_PROTECT_USER_TURNS) continue;
    if (m.parts.some((p) => p.type === 'compaction')) break;
    let changed = false;
    const parts = m.parts.map((p) => {
      if (p.type !== 'tool-result' || p.state !== 'completed') return p;
      total += estimateTokens(toolOutputText(p.output));
      if (total <= PRUNE_PROTECT_TOKENS) return p;
      changed = true;
      return { ...p, output: PRUNE_PLACEHOLDER };
    });
    if (changed) out[i] = { ...m, parts };
  }
  return out;
}

/**
 * 尾部保留起点：从最新往旧按 token 累积，预算内尽量多留（同时受 maxCount 条数上限约束）；
 * 最新一条消息必留（单条超预算也保底保留）；不越过 headIdx。
 */
export function selectTailStart(history: ChatMessage[], headIdx: number, budget: number, maxCount = TAIL_MAX_MESSAGES): number {
  let total = 0;
  let count = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= headIdx; i--) {
    const size = estimateMessageTokens(history[i]!);
    if (total > 0 && (total + size > budget || count >= maxCount)) break;
    total += size;
    count += 1;
    start = i;
  }
  return Math.max(start, headIdx);
}

/** 尾部保留 token 预算：clamp(usable × preserveRatio, MIN, MAX) */
export function tailBudget(usable: number, preserveRatio: number): number {
  const raw = Math.floor(usable * (preserveRatio > 0 ? preserveRatio : 0.25));
  return Math.min(TAIL_BUDGET_MAX, Math.max(TAIL_BUDGET_MIN, raw));
}

// ---- 摘要指令（对齐 opencode buildPrompt/hasSummarySection：模板派生校验集，永不脱钩）----

/** 结构化摘要模板（opencode SUMMARY_TEMPLATE 的中文适配版） */
const SUMMARY_TEMPLATE = [
  '## 任务目标',
  '- [一两句话说明用户在达成什么]',
  '',
  '## 要求与约束',
  '- [用户给出的约束/偏好/范围边界；无则写（无）]',
  '',
  '## 决定',
  '- [已做出并生效的决定及理由；无则写（无）]',
  '',
  '## 工作状态',
  '- [把目标拆小：已完成什么 / 正在做什么 / 被什么阻塞（及原因）]',
  '',
  '## 下一步',
  '1. [接下来应做的有序步骤；无则写（无）]',
  '',
  '## 相关文件',
  '- [后续工作最可能要打开的文件/目录，最重要的在前，≤15 条：`路径`：一句话为什么相关]',
  '',
  '## 关键上下文',
  '- [下一个助手不拿到就续不下去、且无法自行查到的事实；无则写（无）]',
].join('\n');

const SUMMARY_RULES = [
  '规则：',
  '- 各小节简洁：短单行要点，不要长段落或嵌套列表。',
  '- 宁可简短指代、不要详细复述：后续助手能从代码与文件中自行查到的就不展开。',
  '- 精确保留文件路径、符号名、命令、错误原文、URL 与标识符。',
  '- 只带仍未解决/仍需处理的用户问题，已在较新历史里被回答的不重复；要带的保留原话。',
  '- 保留工作流程状态：改动是未提交/已提交/已推送等要写清。',
  '- 不要提及本摘要的生成过程，也不要说"上下文被压缩"之类的话。',
].join('\n');

/** 模板小节标题集合：由模板逐行派生，校验与提示词永不脱钩 */
export const SUMMARY_HEADINGS = SUMMARY_TEMPLATE.split('\n').filter((line) => line.trim().startsWith('##'));

/** 摘要指令（作为请求的最后一条 user 消息发出，不依赖历史里是否有 user 轮） */
export function buildSummaryInstruction(previousSummary?: string): string {
  const prev = previousSummary?.trim();
  const blocks: string[] = [];
  if (prev) {
    blocks.push(
      '请总结以上用户与助手的全部对话和动作，产出一份结构化摘要——它将交给另一个助手据此继续工作。\n\n' +
        '<既有摘要>\n' +
        prev +
        '\n</既有摘要>\n\n' +
        '把 <既有摘要> 与上文历史合并为一份新摘要：更近的历史优先于既有摘要；保留其中仍然成立的约束、决定与未解决问题，按新事实修正过时细节（改写的按新事实写，不保留旧表述）；与继续工作无关的内容可以删除。',
    );
  } else {
    blocks.push('请总结以上用户与助手的全部对话和动作，产出一份结构化摘要——它将交给另一个助手据此继续工作。');
  }
  blocks.push('只总结对话与动作本身；不是用户口述的设定（仓库约定、AGENTS.md 等指令文件、环境信息）不要写入——后续助手会另行获得最新版本。');
  blocks.push(`摘要必须使用以下小节模板（不适用的小节可省略，不要输出模板标签本身）：\n${SUMMARY_TEMPLATE}`);
  blocks.push(SUMMARY_RULES);
  blocks.push('不要继续执行任务、不要调用任何工具。只返回按上述小节标题组织的摘要正文，不要前言、解释或其他额外内容。');
  return blocks.join('\n\n');
}

/** 结构校验失败后的追问指令（opencode 同款：追加在第一次指令之后，不携带上一轮输出） */
export const SUMMARY_REMINDER =
  '上一轮回复没有按要求填写摘要模板。不要调用任何工具，仅以文本、按上文小节标题返回摘要正文。';

/** 输出是否为合规摘要（opencode hasSummarySection：逐行 trim 命中模板标题即有效） */
export function hasSummarySection(text: string): boolean {
  return text.split('\n').some((line) => SUMMARY_HEADINGS.includes(line.trim()));
}
