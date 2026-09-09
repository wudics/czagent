/**
 * 引擎注册表（node 侧）：implId → 实现。与 catalog.ts 的元数据 id 一一对应（缺失即未同步）。
 * 网关按模型的 implId 显式路由；未注册 → 主动中文报错，绝不向未知地址发请求。
 */
import type { ChatEngine } from '../types.js';
import type { MMEngine } from './types.js';
import { deepseekChat } from './chat/deepseek.js';
import { siliconflowChat } from './chat/siliconflow.js';
import { agnesChat } from './chat/agnes.js';
import { bigmodelChat } from './chat/bigmodel.js';
import { qwenChat } from './chat/qwen.js';
import { openrouterChat } from './chat/openrouter.js';
import { openaiCompatibleChat } from './chat/openai-compatible.js';
import { agnesV20Video } from './video/agnes-v20.js';
import { agnes25Video } from './video/agnes-25.js';
import { siliconflowVideo } from './video/siliconflow.js';
import { agnesImage } from './image/agnes.js';
import { openaiImage } from './image/openai.js';
import { openaiEmbed } from './embedding/openai.js';
import { openaiRerank } from './rerank/openai.js';
import { openaiTts } from './audio/tts.js';
import { openaiAsr } from './audio/asr.js';

export const CHAT_ENGINES: Record<string, ChatEngine> = {
  deepseek: deepseekChat,
  siliconflow: siliconflowChat,
  agnes: agnesChat,
  bigmodel: bigmodelChat,
  qwen: qwenChat,
  openrouter: openrouterChat,
  'openai-compatible': openaiCompatibleChat,
};

export const MM_ENGINES: Record<string, MMEngine> = {
  'agnes-video-v2.0': agnesV20Video,
  'agnes-video-2.5': agnes25Video,
  'siliconflow-video': siliconflowVideo,
  'agnes-image': agnesImage,
  'openai-image': openaiImage,
  'openai-embed': openaiEmbed,
  'openai-rerank': openaiRerank,
  'openai-tts': openaiTts,
  'openai-asr': openaiAsr,
};
