/** DeepSeek 对话接口实现：thinking:{type} 开关 + deep 档 reasoning_effort；reasoning_content 字段。 */
import type { ChatBinding, ChatReq, ChatEngine, LLMEvent } from '../../types.js';
import { streamOpenAiChat } from '../openai-stream.js';

export const deepseekChat: ChatEngine = {
  async *stream(b: ChatBinding, req: ChatReq): AsyncGenerator<LLMEvent> {
    yield* streamOpenAiChat(b, req, {
      reasoningField: 'reasoning_content',
      reasoningMessageField: 'reasoning_content',
      // DeepSeek 工具场景要求回传历史 reasoning（缺失 400）
      reasoningPassthrough: true,
      thinkingParams: (m) =>
        m === 'off'
          ? { thinking: { type: 'disabled' } }
          : m === 'deep'
            ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
            : { thinking: { type: 'enabled' } },
    });
  },
};
