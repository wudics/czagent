/** OpenAI 兼容兜底对话实现：纯 OpenAI 格式，无任何平台差异参数。 */
import type { ChatBinding, ChatReq, ChatEngine, LLMEvent } from '../../types.js';
import { streamOpenAiChat } from '../openai-stream.js';

export const openaiCompatibleChat: ChatEngine = {
  async *stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent> {
    yield* streamOpenAiChat(b, req, {
      thinkingParams: () => undefined,
    });
  },
};
