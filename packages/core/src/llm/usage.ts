import type { Usage } from '../provider.js';

/**
 * OpenAI 兼容 usage 归一化（llm-engine.md §7）。
 * 兼容 deepseek（prompt_cache_hit_tokens）、siliconflow（prompt_tokens_details.cached_tokens）等结构。
 */
export function normalizeUsage(u: Record<string, unknown> | undefined): Usage {
  const usage = u ?? {};
  const prompt = (usage.prompt_tokens as number) ?? 0;
  const completion = (usage.completion_tokens as number) ?? 0;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;

  const cacheRead =
    (usage.prompt_cache_hit_tokens as number) ??
    (details.cached_tokens as number) ??
    (details.cache_read_input_tokens as number) ??
    0;

  const reasoning = (completionDetails.reasoning_tokens as number) ?? 0;

  return {
    inputTokens: prompt,
    outputTokens: completion,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: (usage.prompt_cache_miss_tokens as number) ?? 0,
    cost: 0,
  };
}
