/** SiliconFlow 对话接口实现：enable_thinking 开关 + deep 档 thinking_budget；reasoning_content 字段。 */
import type { ChatBinding, ChatReq, ChatEngine, LLMEvent } from '../../types.js';
import { streamOpenAiChat } from '../openai-stream.js';

export const siliconflowChat: ChatEngine = {
  async *stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent> {
    yield* streamOpenAiChat(b, req, {
      reasoningField: 'reasoning_content',
      reasoningMessageField: 'reasoning_content',
      thinkingParams: (m) =>
        m === 'off'
          ? { enable_thinking: false }
          : m === 'deep'
            ? { enable_thinking: true, thinking_budget: 8192 }
            : { enable_thinking: true },
    });
  },
};
