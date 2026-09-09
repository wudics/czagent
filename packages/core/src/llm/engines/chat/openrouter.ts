/** OpenRouter 对话实现：统一 reasoning:{effort} 控制思考（off=none / deep=max）；delta.reasoning 统一思维链字段。 */
import type { ChatBinding, ChatReq, ChatEngine, LLMEvent } from '../../types.js';
import { streamOpenAiChat } from '../openai-stream.js';

export const openrouterChat: ChatEngine = {
  async *stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent> {
    yield* streamOpenAiChat(b, req, {
      reasoningField: 'reasoning',
      thinkingParams: (m) =>
        m === 'off'
          ? { reasoning: { effort: 'none' } }
          : m === 'deep'
            ? { reasoning: { effort: 'max' } }
            : undefined,
    });
  },
};
