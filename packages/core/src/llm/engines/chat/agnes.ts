/** Agnes 对话接口实现：chat_template_kwargs.enable_thinking 开关；reasoning_content 字段。 */
import type { ChatBinding, ChatReq, ChatEngine, LLMEvent } from '../../types.js';
import { streamOpenAiChat } from '../openai-stream.js';

export const agnesChat: ChatEngine = {
  async *stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent> {
    yield* streamOpenAiChat(b, req, {
      reasoningField: 'reasoning_content',
      reasoningMessageField: 'reasoning_content',
      thinkingParams: (m) => ({ chat_template_kwargs: { enable_thinking: m !== 'off' } }),
    });
  },
};
