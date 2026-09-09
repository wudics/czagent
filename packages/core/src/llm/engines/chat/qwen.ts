/** Qwen（阿里云百炼 DashScope OpenAI 兼容模式）对话实现：enable_thinking 开关 + reasoning_effort 档位（deep=xhigh）。 */
import type { ChatBinding, ChatReq, ChatEngine, LLMEvent } from '../../types.js';
import { streamOpenAiChat } from '../openai-stream.js';

export const qwenChat: ChatEngine = {
  async *stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent> {
    yield* streamOpenAiChat(b, req, {
      // qwen3.8 preserve_thinking 默认要求完整回传历史 reasoning_content
      reasoningPassthrough: true,
      thinkingParams: (m) =>
        m === 'off'
          ? { enable_thinking: false }
          : m === 'deep'
            ? { enable_thinking: true, reasoning_effort: 'xhigh' }
            : { enable_thinking: true },
    });
  },
};
