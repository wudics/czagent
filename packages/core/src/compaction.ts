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
/** 保留尾部消息数上限（请求窗口 300 条，尾部 ≤200 留出新空间，避免饱和压缩后立刻再次饱和） */
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

/** provider usage 折算为"上次请求的上下文规模"（对齐 opencode 口径：input+output+cache 全加） */
export function usageTotal(u?: Usage): number {
  if (!u) return 0;
  return u.inputTokens + u.outputTokens + u.reasoningTokens + u.cacheReadTokens + u.cacheWriteTokens;
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
