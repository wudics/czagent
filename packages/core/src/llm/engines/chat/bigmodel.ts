/** BigModel（智谱 GLM）对话实现：thinking:{type} 开关 + reasoning_effort 档位（deep=max）；reasoning_content 字段。 */
import type { ChatBinding, ChatReq, ChatEngine, LLMEvent } from '../../types.js';
import { streamOpenAiChat } from '../openai-stream.js';

export const bigmodelChat: ChatEngine = {
  async *stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent> {
    yield* streamOpenAiChat(b, req, {
      // bigmodel 默认 clear_thinking 清历史思考，不回传 reasoning
      thinkingParams: (m) =>
        m === 'off'
          ? { thinking: { type: 'disabled' } }
          : m === 'deep'
            ? { thinking: { type: 'enabled' }, reasoning_effort: 'max' }
            : { thinking: { type: 'enabled' } },
    });
  },
};
