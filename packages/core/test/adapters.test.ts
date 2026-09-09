/** 引擎/网关测试：implId 显式路由、chat 引擎差异参数、多模态引擎行为（mode 探测/旧格式）、统一报错。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultSettings, type ChatModelConfig, type MultimodalModelConfig, type Settings } from '../src/index.js';
import { CHAT_ENGINES, Gateway } from '../src/node.js';
import { imageGenerateTool, ttsTool, videoGenerateTool, imageEditTool, type ToolContext } from '../src/tools/index.js';
import { isRichToolOutput } from '../src/tools/rich-output.js';

// ---------- 基础设施 ----------

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** SSE 流响应（OpenAI chat/completions chunk 序列） */
function sseResponse(chunks: object[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

type FetchCall = { url: string; method: string; body: string };
let calls: FetchCall[] = [];

/** 按路由表 mock fetch：url → 响应（或函数） */
function stubFetch(routes: Array<{ test: (url: string, method: string, body: string) => boolean; respond: (call: FetchCall) => Response }>): void {
  calls = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const call = { url, method, body };
    calls.push(call);
    const hit = routes.find((r) => r.test(url, method, body));
    if (!hit) throw new Error(`unexpected fetch: ${method} ${url}`);
    return hit.respond(call);
  });
  vi.stubGlobal('fetch', fn);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function chatModel(patch: Partial<ChatModelConfig> = {}): ChatModelConfig {
  return {
    id: 'mdl-chat',
    displayName: '测试对话模型',
    implId: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'key-chat',
    modelName: 'test-chat-model',
    contextLimit: 128_000,
    maxOutput: 8192,
    enabled: true,
    toolcall: true,
    vision: true,
    ...patch,
  };
}

function mmModel(patch: Partial<MultimodalModelConfig> = {}): MultimodalModelConfig {
  return {
    id: 'mm-1',
    displayName: '测试视频模型',
    capability: 'video-generation',
    implId: 'agnes-video-2.5',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: 'key-agnes',
    modelName: 'agnes-video-2.5-flash',
    enabled: true,
    ...patch,
  };
}

function settingsWith(models: { chat?: ChatModelConfig[]; mm?: MultimodalModelConfig[] }, bindings?: Settings['bindings']): Settings {
  const s = createDefaultSettings();
  s.chatModels = models.chat ?? [];
  s.multimodalModels = models.mm ?? [];
  if (bindings) s.bindings = bindings;
  return s;
}

const gateway = new Gateway();

function toolCtx(settings: Settings, progress: string[] = []): ToolContext {
  return {
    sessionId: 's-test',
    cwd: tmpdir(),
    settings,
    gateway,
    signal: new AbortController().signal,
    tempDir: mkdtempSync(join(tmpdir(), 'czagent-mm-test-')),
    reportProgress: (t) => progress.push(t),
    ask: async () => 'deny',
  };
}

/** 将能力绑定指向指定模型 */
function bind(s: Settings, capability: string, modelId: string): Settings {
  return { ...s, bindings: s.bindings.map((b) => (b.capability === capability ? { ...b, modelId } : b)) };
}

/** Agnes 2.5 全流程：创建（可指定失败序列）→ 轮询 → 视频下载 */
function stubAgnesVideoFlow(opts: { model: string; createFails?: number; videoUrl?: string }): void {
  const videoUrl = opts.videoUrl ?? 'https://cdn.example.com/generated/video.mp4';
  let createAttempts = 0;
  stubFetch([
    {
      test: (url, method) => method === 'POST' && url.endsWith('/videos'),
      respond: (call) => {
        createAttempts += 1;
        if (createAttempts <= (opts.createFails ?? 0)) return jsonResponse({ detail: 'mode is invalid' }, 400);
        return jsonResponse({ id: 'task_1', task_id: 'task_1', video_id: 'video_1', model: opts.model, status: 'queued', progress: 0 });
      },
    },
    {
      test: (url, method) => method === 'GET' && url.includes('/agnesapi'),
      respond: () => jsonResponse({ id: 'task_1', video_id: 'video_1', status: 'completed', progress: 100, metadata: { url: videoUrl } }),
    },
    {
      test: (url) => url.startsWith('https://cdn.example.com/'),
      respond: () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    },
  ]);
}

// ---------- 1. 网关：解析/校验/报错 ----------

describe('Gateway 解析与校验', () => {
  it('chat 模型 → 按 implId 路由引擎；binding 携带 baseUrl/apiKey/modelName', async () => {
    const s = settingsWith({ chat: [chatModel({ implId: 'deepseek', baseUrl: 'https://api.deepseek.com/' })] });
    const target = gateway.resolveChat(s, 'mdl-chat');
    expect(target.engine).toBe(CHAT_ENGINES['deepseek']);
    expect(target.binding).toEqual({ baseUrl: 'https://api.deepseek.com', apiKey: 'key-chat', modelName: 'test-chat-model' });
    expect(target.toolcall).toBe(true);
    expect(target.vision).toBe(true);
  });

  it('图片理解模型（multimodal 区）也可作为对话目标', () => {
    const s = settingsWith({ mm: [mmModel({ capability: 'image-understanding', implId: 'agnes', modelName: 'agnes-2.5-flash' })] });
    const target = gateway.resolveChat(s, 'mm-1');
    expect(target.engine).toBe(CHAT_ENGINES['agnes']);
    expect(target.vision).toBe(true);
  });

  it('模型不存在 / Key 缺失 / implId 未注册 → 中文报错（不发请求）', () => {
    const s = settingsWith({ chat: [chatModel()] });
    expect(() => gateway.resolveChat(s, 'nope')).toThrow(/未找到该会话对应的模型/);
    expect(() => gateway.resolveChat(settingsWith({ chat: [chatModel({ apiKey: '' })] }), 'mdl-chat')).toThrow(/尚未配置 API Key/);
    const bad = settingsWith({ chat: [chatModel({ implId: 'no-such-impl' as never })] });
    expect(() => gateway.resolveChat(bad, 'mdl-chat')).toThrow(/接口实现.*不可用/);
  });

  it('能力未绑定 / 绑定模型被禁用 → 报错', async () => {
    stubFetch([]);
    await expect(gateway.embed(createDefaultSettings(), ['x'])).rejects.toThrow(/未配置向量化.*绑定/);
    const s = bind(settingsWith({ mm: [mmModel({ capability: 'embedding', implId: 'openai-embed', enabled: false })] }), 'embedding', 'mm-1');
    await expect(gateway.embed(s, ['x'])).rejects.toThrow(/未配置向量化/);
    expect(calls.length).toBe(0);
  });

  it('openai-image 不支持图生图 → 显式报错并指引换绑', async () => {
    stubFetch([]);
    const s = bind(settingsWith({ mm: [mmModel({ capability: 'image-generation', implId: 'openai-image', baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'kolors' })] }), 'image-generation', 'mm-1');
    await expect(gateway.editImage(s, { prompt: 'x', images: ['https://a.b/c.png'] })).rejects.toThrow(/不支持图生图.*Agnes/);
    expect(calls.length).toBe(0);
  });
});

// ---------- 2. chat 引擎：各 provider 差异参数写死在各自实现 ----------

describe('chat 引擎差异', () => {
  const cases: Array<{ implId: ChatModelConfig['implId']; thinking: Record<string, unknown>; thinkingDeep?: Record<string, unknown>; thinkingOff?: Record<string, unknown> }> = [
    { implId: 'deepseek', thinking: { thinking: { type: 'enabled' } }, thinkingDeep: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }, thinkingOff: { thinking: { type: 'disabled' } } },
    { implId: 'siliconflow', thinking: { enable_thinking: true }, thinkingDeep: { enable_thinking: true, thinking_budget: 8192 }, thinkingOff: { enable_thinking: false } },
    { implId: 'agnes', thinking: { chat_template_kwargs: { enable_thinking: true } }, thinkingOff: { chat_template_kwargs: { enable_thinking: false } } },
    { implId: 'bigmodel', thinking: { thinking: { type: 'enabled' } }, thinkingDeep: { thinking: { type: 'enabled' }, reasoning_effort: 'max' }, thinkingOff: { thinking: { type: 'disabled' } } },
    { implId: 'qwen', thinking: { enable_thinking: true }, thinkingDeep: { enable_thinking: true, reasoning_effort: 'xhigh' }, thinkingOff: { enable_thinking: false } },
    { implId: 'openrouter', thinking: {}, thinkingDeep: { reasoning: { effort: 'max' } }, thinkingOff: { reasoning: { effort: 'none' } } },
    { implId: 'openai-compatible', thinking: {} },
  ];

  for (const c of cases) {
    it(`${c.implId}：on/deep/off 档位差异`, async () => {
      stubFetch([
        { test: (url, method) => method === 'POST' && url.endsWith('/chat/completions'), respond: () => sseResponse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]) },
      ]);
      const s = settingsWith({ chat: [chatModel({ implId: c.implId })] });
      const modes: Array<['on' | 'deep' | 'off', Record<string, unknown> | undefined]> = [
        ['on', c.thinking],
        ...(c.thinkingDeep ? [['deep', c.thinkingDeep] as ['deep', Record<string, unknown>]] : []),
        ...(c.thinkingOff ? [['off', c.thinkingOff] as ['off', Record<string, unknown>]] : []),
      ];
      for (const [mode, expected] of modes) {
        let last = '';
        for await (const ev of gateway.chat(s, 'mdl-chat', { messages: [{ role: 'user', content: 'hi' }], thinking: mode })) {
          if (ev.type === 'text-delta') last += ev.text;
        }
        expect(last).toBe('hi');
        const body = JSON.parse(calls.at(-1)!.body);
        for (const [k, v] of Object.entries(expected ?? {})) expect(body[k]).toEqual(v);
      }
    });
  }

  it('reasoning_content delta → reasoning-delta 事件；usage 归一化', async () => {
    stubFetch([
      {
        test: (url, method) => method === 'POST' && url.endsWith('/chat/completions'),
        respond: () =>
          sseResponse([
            { choices: [{ delta: { reasoning_content: '想一下' } }] },
            { choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 3 } },
          ]),
      },
    ]);
    const s = settingsWith({ chat: [chatModel({ implId: 'deepseek' })] });
    const events = [];
    for await (const ev of gateway.chat(s, 'mdl-chat', { messages: [{ role: 'user', content: 'q' }], thinking: 'on' })) events.push(ev);
    expect(events.some((e) => e.type === 'reasoning-delta' && e.text === '想一下')).toBe(true);
    const finish = events.find((e) => e.type === 'finish');
    expect(finish && finish.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  });

  it('openrouter 统一 reasoning delta → reasoning-delta 事件', async () => {
    stubFetch([
      {
        test: (url, method) => method === 'POST' && url.endsWith('/chat/completions'),
        respond: () =>
          sseResponse([
            { choices: [{ delta: { reasoning: '想想' } }] },
            { choices: [{ delta: { content: '好', finish_reason: 'stop' } }] },
          ]),
      },
    ]);
    const s = settingsWith({ chat: [chatModel({ implId: 'openrouter' })] });
    const events = [];
    for await (const ev of gateway.chat(s, 'mdl-chat', { messages: [{ role: 'user', content: 'q' }], thinking: 'on' })) events.push(ev);
    expect(events.some((e) => e.type === 'reasoning-delta' && e.text === '想想')).toBe(true);
    expect(events.some((e) => e.type === 'text-delta' && e.text === '好')).toBe(true);
  });

  it('tools/options/maxTokens 注入请求体', async () => {
    stubFetch([
      { test: (url, method) => method === 'POST' && url.endsWith('/chat/completions'), respond: () => sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]) },
    ]);
    const s = settingsWith({ chat: [chatModel({ options: { temperature: 0.5 } })] });
    for await (const _ of gateway.chat(s, 'mdl-chat', {
      messages: [{ role: 'user', content: 'q' }],
      thinking: 'off',
      maxTokens: 128,
      tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
    })) {
      // 消费完毕
    }
    const body = JSON.parse(calls.at(-1)!.body);
    expect(body).toMatchObject({ max_tokens: 128, temperature: 0.5 });
    expect(body.tools).toHaveLength(1);
  });
});

// ---------- 3. 多模态引擎：agnes 2.5 / v2.0 视频、图像、语音 ----------

describe('agnes 2.5 视频引擎', () => {
  it('创建 → 轮询 → 返回 videoId/taskId/model/implementation/queryUrl；进度上报 video_id', async () => {
    stubAgnesVideoFlow({ model: 'agnes-video-2.5-flash' });
    const s = bind(settingsWith({ mm: [mmModel()] }), 'video-generation', 'mm-1');
    const progress: string[] = [];
    const out = await videoGenerateTool.execute({ prompt: '一只猫', seconds: '5', pollIntervalMs: 1 }, toolCtx(s, progress));
    expect(isRichToolOutput(out)).toBe(true);
    const text = (out as { text: string }).text;
    expect(text).toContain('视频 ID：video_1');
    expect(text).toContain('任务 ID：task_1');
    expect(text).toContain('模型：agnes-video-2.5-flash');
    expect(text).toContain('Agnes · 2.5 格式');
    expect(text).toContain('来源：https://cdn.example.com/generated/video.mp4');
    expect(progress.some((p) => p.includes('视频任务已创建（video_id=video_1）'))).toBe(true);
  });

  it('mode 探测：文档值 400 → 回退旧值成功；成功值缓存后不再重试', async () => {
    stubAgnesVideoFlow({ model: 'agnes-video-2.5-probe-a', createFails: 1 });
    const s = bind(settingsWith({ mm: [mmModel({ modelName: 'agnes-video-2.5-probe-a' })] }), 'video-generation', 'mm-1');
    await videoGenerateTool.execute({ prompt: 'x', pollIntervalMs: 1 }, toolCtx(s));
    const createBodies = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/videos')).map((c) => JSON.parse(c.body));
    expect(createBodies.map((b) => b.mode)).toEqual(['text', 'ti2vid']);

    stubAgnesVideoFlow({ model: 'agnes-video-2.5-probe-a' });
    await videoGenerateTool.execute({ prompt: 'y', pollIntervalMs: 1 }, toolCtx(s));
    const retryBodies = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/videos')).map((c) => JSON.parse(c.body));
    expect(retryBodies.map((b) => b.mode)).toEqual(['ti2vid']);
  });

  it('请求体：2.5 格式携带 seconds/mode/size=720P/aspect_ratio', async () => {
    stubAgnesVideoFlow({ model: 'agnes-video-2.5-body' });
    const s = bind(settingsWith({ mm: [mmModel({ modelName: 'agnes-video-2.5-body' })] }), 'video-generation', 'mm-1');
    await videoGenerateTool.execute({ prompt: 'x', seconds: '8', aspectRatio: '9:16', pollIntervalMs: 1 }, toolCtx(s));
    const body = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/videos'))!.body);
    expect(body).toMatchObject({ model: 'agnes-video-2.5-body', seconds: '8', size: '720P', aspect_ratio: '9:16' });
    expect(typeof body.mode).toBe('string');
  });
});

describe('agnes v2.0 视频引擎', () => {
  it('旧格式请求体：width/height/num_frames/frame_rate；num_frames 满足 8n+1 且 ≤441', async () => {
    stubFetch([
      {
        test: (url, method) => method === 'POST' && url.endsWith('/videos'),
        respond: () => jsonResponse({ id: 'task_v2', video_id: 'video_v2', status: 'queued' }),
      },
      { test: (url, method) => method === 'GET' && url.includes('/agnesapi'), respond: () => jsonResponse({ status: 'completed', metadata: { url: 'https://cdn.example.com/v2.mp4' } }) },
      { test: (url) => url.startsWith('https://cdn.example.com/'), respond: () => new Response(new Uint8Array([1]), { status: 200 }) },
    ]);
    const s = bind(settingsWith({ mm: [mmModel({ implId: 'agnes-video-v2.0', modelName: 'agnes-video-v2.0' })] }), 'video-generation', 'mm-1');
    await videoGenerateTool.execute({ prompt: 'x', seconds: '5.5', aspectRatio: '9:16', pollIntervalMs: 1 }, toolCtx(s));
    const body = JSON.parse(calls.find((c) => c.method === 'POST' && urlPostVideos(c.url))!.body);
    expect(body.model).toBe('agnes-video-v2.0');
    expect(body.width).toBe(648); // 9:16
    expect(body.height).toBe(1152);
    expect(body.frame_rate).toBe(24);
    // 5.5s → 132 帧 → 向上取整到 8n+1 = 137
    expect(body.num_frames).toBe(137);
    expect((body.num_frames - 1) % 8).toBe(0);
    expect(body.num_frames).toBeLessThanOrEqual(441);
  });
});

function urlPostVideos(url: string): boolean {
  return url.endsWith('/videos');
}

describe('图像 / 语音引擎', () => {
  it('图像生成：返回 richOutput 对象（含 images dataUrl + files），text 不含 base64', async () => {
    stubFetch([
      { test: (url, method) => method === 'POST' && url.endsWith('/images/generations'), respond: () => jsonResponse({ data: [{ b64_json: 'QUJD' }] }) },
    ]);
    const s = bind(settingsWith({ mm: [mmModel({ capability: 'image-generation', implId: 'agnes-image', modelName: 'agnes-image-2.1-flash' })] }), 'image-generation', 'mm-1');
    const out = await imageGenerateTool.execute({ prompt: '一朵花', size: '2K' }, toolCtx(s));
    expect(isRichToolOutput(out)).toBe(true);
    const rich = out as { text: string; images: { dataUrl: string }[]; files: { kind: string }[] };
    expect(rich.images[0]!.dataUrl).toBe('data:image/png;base64,QUJD');
    expect(rich.files[0]!.kind).toBe('image');
    expect(rich.text).not.toContain('QUJD');
    expect(rich.text).toContain('已生成 1 张图片');
    const body = JSON.parse(calls.at(-1)!.body);
    expect(body).toMatchObject({ model: 'agnes-image-2.1-flash', size: '2K', return_base64: true });
  });

  it('图生图（edit）走 Agnes 引擎：参考图进 extra_body.image', async () => {
    stubFetch([
      { test: (url, method) => method === 'POST' && url.endsWith('/images/generations'), respond: () => jsonResponse({ data: [{ b64_json: 'QUJD' }] }) },
    ]);
    const s = bind(settingsWith({ mm: [mmModel({ capability: 'image-generation', implId: 'agnes-image', modelName: 'agnes-image-2.1-flash' })] }), 'image-generation', 'mm-1');
    await imageEditTool.execute({ prompt: '改成水彩风', image: ['https://a.b/c.png'] }, toolCtx(s));
    const body = JSON.parse(calls.at(-1)!.body);
    expect(body.extra_body.image).toEqual(['https://a.b/c.png']);
  });

  it('TTS：voice 简写自动补模型前缀', async () => {
    stubFetch([
      { test: (url, method) => method === 'POST' && url.endsWith('/audio/speech'), respond: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }) },
    ]);
    const s = bind(settingsWith({ mm: [mmModel({ capability: 'tts', implId: 'openai-tts', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'key-tts', modelName: 'fnlp/MOSS-TTSD-v0.5' })] }), 'tts', 'mm-1');
    await ttsTool.execute({ text: '你好', voice: 'anna' }, toolCtx(s));
    const body = JSON.parse(calls.at(-1)!.body);
    expect(body).toMatchObject({ model: 'fnlp/MOSS-TTSD-v0.5', input: '你好', voice: 'fnlp/MOSS-TTSD-v0.5:anna', response_format: 'mp3' });
  });
});

// ---------- 4. 目录元数据（渲染层下拉来源） ----------

describe('接口实现目录', () => {
  it('chat 实现含 openai-compatible 兜底；多模态实现按能力可过滤', async () => {
    const { CHAT_IMPL_META, MM_IMPL_META } = await import('../src/index.js');
    expect(CHAT_IMPL_META.map((m) => m.id)).toContain('openai-compatible');
    expect(CHAT_IMPL_META.every((m) => m.category === 'chat')).toBe(true);
    const videoImpls = MM_IMPL_META.filter((m) => m.category === 'video-generation').map((m) => m.id);
    expect(videoImpls).toEqual(['agnes-video-v2.0', 'agnes-video-2.5', 'siliconflow-video']);
    // 目录与注册表一一对应
    for (const m of CHAT_IMPL_META) expect(CHAT_ENGINES[m.id]).toBeDefined();
  });
});
