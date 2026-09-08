import type { ThinkingMode, Usage } from '../provider.js';
import type { LLMError } from './errors.js';

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** 该条 assistant 的思考内容（按平台回传规则注入 reasoning_content） */
  reasoning?: string;
  /** assistant 的工具调用（OpenAI 格式回填） */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** role:'tool' 时对应的 tool_call_id */
  toolCallId?: string;
  /** user 消息的图片（data URL）→ 以 content 块形式发送 */
  images?: { dataUrl: string }[];
}

export type LLMEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; callID: string; tool: string }
  | { type: 'tool-call-delta'; callID: string; text: string }
  | { type: 'tool-call'; callID: string; tool: string; input: unknown }
  | { type: 'finish'; finishReason: string; usage?: Usage }
  | { type: 'error'; error: LLMError };

export interface ChatStreamRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LLMChatMessage[];
  thinking: ThinkingMode;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 平台差异（见 profile.ts） */
  path?: string;
  headers?: Record<string, string>;
  thinkingParams?: (mode: ThinkingMode) => Record<string, unknown> | undefined;
  reasoningField?: string;
  reasoningMessageField?: string;
  reasoningPassthrough?: boolean;
  /** OpenAI 格式的 tools 数组（已含 type/function/parameters） */
  tools?: Record<string, unknown>[];
  options?: Record<string, unknown>;
}
