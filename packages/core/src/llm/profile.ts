import type { ThinkingMode } from '../provider.js';

/**
 * OpenAI 兼容 Chat 协议的平台差异 profile（llm-engine.md §4.3）。
 */
export interface ChatProfile {
  id: string;
  baseUrl: string;
  path?: string;
  headers?: Record<string, string>;
  /** 思考模式 → 请求体参数 */
  thinkingParams?: (mode: ThinkingMode) => Record<string, unknown> | undefined;
  /** 流式 delta 中承载思考内容的字段（默认 reasoning_content） */
  reasoningField?: string;
  /** 回传历史 assistant 思考内容时使用的字段 */
  reasoningMessageField?: string;
  /** 是否必须回传 reasoning（DeepSeek 工具场景 400 规则，R4） */
  reasoningPassthrough?: boolean;
  options?: Record<string, unknown>;
}

export const BUILTIN_PROFILES: Record<string, ChatProfile> = {
  deepseek: {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    path: '/chat/completions',
    thinkingParams: (m) =>
      m === 'off'
        ? { thinking: { type: 'disabled' } }
        : m === 'deep'
          ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
          : { thinking: { type: 'enabled' } },
    reasoningField: 'reasoning_content',
    reasoningMessageField: 'reasoning_content',
    reasoningPassthrough: true,
  },
  siliconflow: {
    id: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    path: '/chat/completions',
    thinkingParams: (m) =>
      m === 'off'
        ? { enable_thinking: false }
        : m === 'deep'
          ? { enable_thinking: true, thinking_budget: 8192 }
          : { enable_thinking: true },
    reasoningField: 'reasoning_content',
    reasoningMessageField: 'reasoning_content',
  },
  agnes: {
    id: 'agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    path: '/chat/completions',
    thinkingParams: (m) => ({ chat_template_kwargs: { enable_thinking: m !== 'off' } }),
    reasoningField: 'reasoning_content',
    reasoningMessageField: 'reasoning_content',
  },
};

export function getBuiltinProfile(id: string): ChatProfile | undefined {
  return BUILTIN_PROFILES[id];
}

/** 自定义 OpenAI 兼容厂商的通用 profile */
export function createGenericProfile(baseUrl: string): ChatProfile {
  return { id: 'openai-compatible', baseUrl, path: '/chat/completions' };
}
