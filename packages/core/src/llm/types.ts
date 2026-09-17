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
  | { type: 'tool-call'; callID: string; tool: string; input: unknown; /** 参数非法 JSON 时携带原始串（input=原始文本），由调用方合成错误结果 */ parseError?: string }
  | { type: 'finish'; finishReason: string; usage?: Usage }
  | { type: 'error'; error: LLMError };

/** 对话引擎的连接信息（来自模型配置，网关解析后传入） */
export interface ChatBinding {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/** 对话请求（纯业务字段；协议差异由各家引擎自行处理） */
export interface ChatReq {
  messages: LLMChatMessage[];
  thinking: ThinkingMode;
  maxTokens?: number;
  signal?: AbortSignal;
  /** OpenAI 格式的 tools 数组（已含 type/function/parameters） */
  tools?: Record<string, unknown>[];
  /** 额外请求体参数（模型 options 透传） */
  options?: Record<string, unknown>;
}

/**
 * 对话引擎接口：每家 provider（含不同 API 版本）一个独立实现（llm/engines/chat/*），
 * 请求组装、思考参数、reasoning 字段等协议差异全部写死在各自文件内。
 */
export interface ChatEngine {
  stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent>;
}
