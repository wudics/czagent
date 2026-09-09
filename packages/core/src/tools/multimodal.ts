/** 多模态能力工具（embed / rerank / 图像（文生图/图生图）/ 视频（文/图生）/ tts / asr）。
 *  模型来自能力绑定（settings.bindings）；解析/校验/路由全部收敛到 gateway（按模型 implId 显式路由引擎），
 *  本文件只做：参数校验 → gateway 调用 → 落盘/富输出/进度。 */
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolDef, ToolContext } from './types.js';
import type { GatewayCtx } from '../llm/gateway.js';
import { richOutput } from './rich-output.js';
import { toDataUrl } from '../llm/engines/mm.js';

function gctx(ctx: ToolContext): GatewayCtx {
  return { signal: ctx.signal, report: (msg) => ctx.reportProgress?.(msg) };
}

async function saveTemp(tempDir: string | undefined, sessionId: string, filename: string, data: Buffer): Promise<string> {
  const dir = join(tempDir ?? join(process.cwd(), 'czagent-temp'), sessionId);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await fs.writeFile(path, data);
  return path;
}

/** 周期计时进度（同步等待型 API：图像生成/编辑无进度接口） */
function startTicker(ctx: ToolContext, label: string): () => void {
  const started = Date.now();
  const ticker = setInterval(() => {
    ctx.reportProgress?.(`${label}…（已等待 ${Math.round((Date.now() - started) / 1000)}s）`);
  }, 2_000);
  return () => clearInterval(ticker);
}

// ---------- 各能力实现（薄壳：参数校验 + gateway 调用 + 结果后处理） ----------

async function doEmbed(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const texts = Array.isArray(input.texts) ? (input.texts as string[]) : [String(input.text ?? '')];
  const vectors = await ctx.gateway.embed(ctx.settings, texts, gctx(ctx));
  return JSON.stringify(texts.length === 1 ? vectors[0] : vectors);
}

async function doRerank(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const query = String(input.query ?? '');
  const documents = Array.isArray(input.documents) ? (input.documents as string[]) : [];
  const topN = Number(input.topN ?? documents.length);
  if (!query || documents.length === 0) throw new Error('缺少 query 或 documents');
  const hits = await ctx.gateway.rerank(ctx.settings, { query, documents, topN }, gctx(ctx));
  const lines = hits.map((r, i) => `${i + 1}. [相关性 ${r.score !== undefined ? r.score.toFixed(4) : '?'}] ${documents[r.index] ?? '?'}`);
  return `重排序结果（${lines.length} 条）：\n${lines.join('\n')}`;
}

async function doImageGenerate(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('缺少 prompt 参数');
  const stopTicker = startTicker(ctx, '图像生成中');
  try {
    const outputs = await ctx.gateway.generateImage(
      ctx.settings,
      {
        prompt,
        size: input.size ? String(input.size) : undefined,
        ratio: input.ratio ? String(input.ratio) : undefined,
      },
      gctx(ctx),
    );
    if (outputs.length === 0) throw new Error('图像生成响应为空');
    const dataUrls = await Promise.all(outputs.map(toDataUrl));
    const saved: string[] = [];
    for (let i = 0; i < dataUrls.length; i++) {
      const b64 = dataUrls[i]!.split(',')[1] ?? '';
      const path = await saveTemp(ctx.tempDir, ctx.sessionId, `generated-${Date.now()}-${i}.png`, Buffer.from(b64, 'base64'));
      saved.push(path);
    }
    // 富输出：图片直接显示在消息流（dataUrl），模型只收到路径与预览信息（不含 base64）
    return richOutput({
      text: `已生成 ${dataUrls.length} 张图片：\n${saved.join('\n')}`,
      images: dataUrls.map((dataUrl, i) => ({ dataUrl, name: `generated-${i}.png` })),
      files: saved.map((p) => ({ path: p, name: basename(p), kind: 'image' })),
    });
  } finally {
    stopTicker();
  }
}

/** 图生图（仅 Agnes 图像实现提供 edit；其余实现在 gateway 显式报错并给出换绑指引） */
async function doImageEdit(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const prompt = String(input.prompt ?? '').trim();
  const imageInputs = Array.isArray(input.image) ? (input.image as string[]) : [];
  if (!prompt) throw new Error('缺少 prompt 参数');
  if (imageInputs.length === 0) throw new Error('缺少 image 参数（参考图 URL 或本地文件路径）');
  const stopTicker = startTicker(ctx, '图像编辑中');
  try {
    const outputs = await ctx.gateway.editImage(
      ctx.settings,
      {
        prompt,
        images: imageInputs,
        size: input.size ? String(input.size) : undefined,
        ratio: input.ratio ? String(input.ratio) : undefined,
      },
      gctx(ctx),
    );
    if (outputs.length === 0) throw new Error('图像编辑响应为空');
    const dataUrls = await Promise.all(outputs.map(toDataUrl));
    const saved: string[] = [];
    for (let i = 0; i < dataUrls.length; i++) {
      const b64 = dataUrls[i]!.split(',')[1] ?? '';
      const path = await saveTemp(ctx.tempDir, ctx.sessionId, `edited-${Date.now()}-${i}.png`, Buffer.from(b64, 'base64'));
      saved.push(path);
    }
    return richOutput({
      text: `图像编辑完成（${dataUrls.length} 张）：\n${saved.join('\n')}`,
      images: dataUrls.map((dataUrl, i) => ({ dataUrl, name: `edited-${i}.png` })),
      files: saved.map((p) => ({ path: p, name: basename(p), kind: 'image' })),
    });
  } finally {
    stopTicker();
  }
}

async function downloadVideo(videoUrl: string, ctx: ToolContext): Promise<string> {
  ctx.reportProgress?.('视频生成完成，下载中…');
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`视频下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return saveTemp(ctx.tempDir, ctx.sessionId, `generated-${Date.now()}.mp4`, buf);
}

function videoRichOutput(path: string, started: number, r: { url: string; videoId?: string; taskId?: string; model: string; implementation: string }): unknown {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const lines = [`视频已生成（耗时 ${seconds}s）`, `文件：${path}`, `模型：${r.model}（接口实现：${r.implementation}）`];
  if (r.videoId) lines.push(`视频 ID：${r.videoId}`);
  if (r.taskId) lines.push(`任务 ID：${r.taskId}`);
  lines.push(`来源：${r.url}`);
  return richOutput({ text: lines.join('\n'), files: [{ path, name: basename(path), kind: 'video' }] });
}

async function doVideoGenerate(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('缺少 prompt 参数');
  const started = Date.now();
  const result = await ctx.gateway.generateVideo(
    ctx.settings,
    {
      prompt,
      seconds: input.seconds ? String(input.seconds) : undefined,
      aspectRatio: input.aspectRatio ? String(input.aspectRatio) : undefined,
      pollIntervalMs: input.pollIntervalMs ? Number(input.pollIntervalMs) : undefined,
    },
    gctx(ctx),
  );
  const path = await downloadVideo(result.url, ctx);
  return videoRichOutput(path, started, result);
}

/** 图生视频：首帧素材的 URL/本地路径规则、尾帧支持性、mode 值探测等差异在引擎内 */
async function doVideoFromFrame(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const prompt = String(input.prompt ?? '').trim();
  const firstFrame = String(input.firstFrame ?? '').trim();
  if (!prompt) throw new Error('缺少 prompt 参数');
  if (!firstFrame) throw new Error('缺少 firstFrame 参数（首帧图片 URL）');
  const started = Date.now();
  const result = await ctx.gateway.videoFromFrame(
    ctx.settings,
    {
      prompt,
      firstFrame,
      lastFrame: input.lastFrame ? String(input.lastFrame) : undefined,
      seconds: input.seconds ? String(input.seconds) : undefined,
      aspectRatio: input.aspectRatio ? String(input.aspectRatio) : undefined,
      pollIntervalMs: input.pollIntervalMs ? Number(input.pollIntervalMs) : undefined,
    },
    gctx(ctx),
  );
  const path = await downloadVideo(result.url, ctx);
  return videoRichOutput(path, started, result);
}

async function doTts(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('缺少 text 参数');
  const buf = await ctx.gateway.tts(ctx.settings, { text, voice: input.voice !== undefined ? String(input.voice) : undefined }, gctx(ctx));
  const path = await saveTemp(ctx.tempDir, ctx.sessionId, `tts-${Date.now()}.mp3`, buf);
  return richOutput({ text: `语音已生成：\n${path}`, files: [{ path, name: basename(path), kind: 'audio' }] });
}

async function doAsr(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const file = String(input.file ?? '').trim();
  if (!file) throw new Error('缺少 file 参数（本地音频文件路径）');
  const buffer = await fs.readFile(file);
  return ctx.gateway.asr(ctx.settings, { buffer, filename: basename(file) }, gctx(ctx));
}

// ---------- 工具定义 ----------

export const embedTool: ToolDef = {
  id: 'embed',
  description: '将文本转为语义向量（embedding）。输入 text（单条）或 texts（多条数组），返回向量 JSON',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '单条文本' },
      texts: { type: 'array', items: { type: 'string' }, description: '多条文本（与 text 二选一）' },
    },
  },
  execute: (input, ctx) => doEmbed(input as Record<string, unknown>, ctx),
};

export const rerankTool: ToolDef = {
  id: 'rerank',
  description: '按查询相关性对一组文档重排序（rerank）。输入 query 与 documents 数组，返回排序结果',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询' },
      documents: { type: 'array', items: { type: 'string' }, description: '排序文档数组' },
      topN: { type: 'number', description: '返回前 N 条，默认全部' },
    },
    required: ['query', 'documents'],
  },
  execute: (input, ctx) => doRerank(input as Record<string, unknown>, ctx),
};

export const imageGenerateTool: ToolDef = {
  id: 'image-generate',
  description: '根据文本提示词生成图片（文生图）。生成结果直接显示在消息流并保存为文件',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '图像描述（主体+场景+风格+光照+构图）' },
      size: { type: 'string', description: '输出尺寸：agnes 用档位 1K/2K/3K/4K，siliconflow 用 1024x1024 等精确尺寸（默认 1024x1024 / 1K）' },
      ratio: { type: 'string', description: '宽高比（仅 agnes）：1:1、16:9、9:16 等，默认 1:1' },
    },
    required: ['prompt'],
  },
  execute: (input, ctx) => doImageGenerate(input as Record<string, unknown>, ctx),
};

export const imageEditTool: ToolDef = {
  id: 'image-edit',
  description: '图生图/图片编辑：基于参考图（URL 或本地路径）按提示词转换、重绘或风格化编辑（支持多图合成）。当前仅支持 Agnes 图像模型',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '编辑指令：改变要求 + 新风格/场景 + 需要保留的元素' },
      image: { type: 'array', items: { type: 'string' }, description: '参考图（URL 或本地文件路径；多图合成传多张）' },
      size: { type: 'string', description: '输出尺寸档位（agnes）：1K/2K/3K/4K，默认 1K' },
      ratio: { type: 'string', description: '宽高比（agnes）：1:1、16:9 等，默认 1:1' },
    },
    required: ['prompt', 'image'],
  },
  execute: (input, ctx) => doImageEdit(input as Record<string, unknown>, ctx),
};

export const videoGenerateTool: ToolDef = {
  id: 'video-generate',
  description: '根据文本提示词生成短视频（文生视频）。生成视频保存为本地文件并返回路径',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '视频内容描述' },
      seconds: { type: 'string', description: '视频时长（仅 agnes）：字符串 "4"–"12"，默认 "5"' },
      aspectRatio: { type: 'string', description: '画幅：16:9、9:16、1:1 等，默认 16:9' },
    },
    required: ['prompt'],
  },
  execute: (input, ctx) => doVideoGenerate(input as Record<string, unknown>, ctx),
};

export const videoFromFrameTool: ToolDef = {
  id: 'video-from-frame',
  description:
    '图生视频：以首帧（可选尾帧）图片为起点生成视频。需绑定支持图生视频的模型（如 Wan2.2-I2V / Agnes Video）；首帧需为公开可访问的 URL',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '视频内容描述（镜头如何从首帧推进）' },
      firstFrame: { type: 'string', description: '首帧图片 URL（公开可访问）' },
      lastFrame: { type: 'string', description: '尾帧图片 URL（可选，仅 agnes）' },
      seconds: { type: 'string', description: '视频时长（仅 agnes）：字符串 "4"–"12"，默认 "5"' },
      aspectRatio: { type: 'string', description: '画幅：16:9、9:16、1:1 等，默认 16:9' },
    },
    required: ['prompt', 'firstFrame'],
  },
  execute: (input, ctx) => doVideoFromFrame(input as Record<string, unknown>, ctx),
};

export const ttsTool: ToolDef = {
  id: 'tts',
  description:
    '文字转语音（TTS）。输入 text，生成 mp3 文件并返回路径。根据用户对音色性别/风格的要求从预置音色中选择：alex（男·沉稳）、benjamin（男·低沉）、charles（男·磁性）、david（男·欢快）、anna（女·沉稳）、bella（女·激情）、claire（女·温柔）、diana（女·欢快）。MOSS-TTSD 建议使用 [S1]/[S2] 对话脚本格式输入',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要合成的文本（MOSS-TTSD 模型建议用 [S1]/[S2] 标记对话轮次）' },
      voice: { type: 'string', description: '音色名（见描述中的音色列表，或完整 <model>:<音色> / speech: 自定义 URI），默认 alex' },
    },
    required: ['text'],
  },
  execute: (input, ctx) => doTts(input as Record<string, unknown>, ctx),
};

export const asrTool: ToolDef = {
  id: 'asr',
  description: '语音识别（ASR）：把本地音频文件转写为文本',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '本地音频文件路径（mp3/wav 等）' },
    },
    required: ['file'],
  },
  execute: (input, ctx) => doAsr(input as Record<string, unknown>, ctx),
};
