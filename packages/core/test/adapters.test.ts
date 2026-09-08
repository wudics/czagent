/** I17 适配层测试：profile 解析矩阵（特定/兜底/报错）、2.5 mode 自动探测、VideoTaskResult、富输出对象。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultSettings, detectStyle, resolveProfileMeta, type Settings } from '../src/index.js';
import { imageGenerateTool, ttsTool, videoGenerateTool, type ToolContext } from '../src/tools/index.js';
import { isRichToolOutput } from '../src/tools/rich-output.js';
import type { MMFeature } from '../src/adapters/types.js';

// ---------- 工具 ----------

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
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

function agnesSettings(): Settings {
  const s = createDefaultSettings();
  s.providers = s.providers.map((p) => (p.id === 'agnes' ? { ...p, apiKey: 'key-agnes' } : p));
  return s;
}

/** 将视频生成绑定指向指定模型（唯一模型名可隔离 mode 探测缓存） */
function setVideoModel(s: Settings, modelId: string): Settings {
  return {
    ...s,
    bindings: s.bindings.map((b) => (b.capability === 'video-generation' ? { ...b, modelId } : b)),
    models: [
      ...s.models.filter((m) => m.id !== modelId),
      { id: modelId, provider: 'agnes', name: modelId, capability: 'video-generation', contextLimit: 0, maxOutput: 0, enabled: true, builtin: false, toolcall: false, vision: false },
    ],
  };
}

function toolCtx(settings: Settings, progress: string[] = []): ToolContext {
  return {
    sessionId: 's-test',
    cwd: tmpdir(),
    settings,
    signal: new AbortController().signal,
    tempDir: mkdtempSync(join(tmpdir(), 'czagent-mm-test-')),
    reportProgress: (t) => progress.push(t),
    ask: async () => 'deny',
  };
}

/** Agnes 2.5 全流程路由：创建（可指定失败序列）→ 轮询 → 视频下载 */
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

// ---------- 1. 风格判定与 profile 解析矩阵 ----------

describe('detectStyle', () => {
  it('providerId=agnes 或模型 agnes- 前缀 → agnes；显式 apiStyle 优先', () => {
    expect(detectStyle({ providerId: 'agnes', model: 'foo' })).toBe('agnes');
    expect(detectStyle({ providerId: 'p1', model: 'agnes-video-2.5' })).toBe('agnes');
    expect(detectStyle({ providerId: 'p1', model: 'wan2.2-t2v' })).toBe('openai');
    expect(detectStyle({ providerId: 'siliconflow', model: 'wan2.2-t2v', apiStyle: 'agnes' })).toBe('agnes');
    expect(detectStyle({ providerId: 'agnes', model: 'agnes-video-2.5', apiStyle: 'openai' })).toBe('openai');
  });
});

describe('resolveProfileMeta 解析链', () => {
  it('视频：v2.0 → 特定实现', () => {
    const m = resolveProfileMeta({ providerId: 'agnes', model: 'agnes-video-v2.0' }, 'video-generate');
    expect([m.profile.id, m.kind]).toEqual(['agnes-video-v2.0', 'specific']);
  });

  it('视频：2.5-flash → 特定实现 agnes-video-2.5', () => {
    const m = resolveProfileMeta({ providerId: 'agnes', model: 'agnes-video-2.5-flash' }, 'video-generate');
    expect([m.profile.id, m.kind]).toEqual(['agnes-video-2.5', 'specific']);
  });

  it('视频：未知 agnes 模型 → 兼容兜底 agnes-video-2.5（default）', () => {
    const m = resolveProfileMeta({ providerId: 'agnes', model: 'agnes-video-9.9' }, 'video-generate');
    expect([m.profile.id, m.kind]).toEqual(['agnes-video-2.5', 'default']);
  });

  it('视频：openai 风格 → 兼容兜底 siliconflow-async', () => {
    const m = resolveProfileMeta({ providerId: 'siliconflow', model: 'wan2.2-t2v' }, 'video-from-frame');
    expect([m.profile.id, m.kind]).toEqual(['siliconflow-async', 'default']);
  });

  it('图像：agnes 生图/图生图 → agnes-image；openai 生图 → openai-image；openai 图生图 → 明确报错', () => {
    expect(resolveProfileMeta({ providerId: 'agnes', model: 'agnes-image-2.1-flash' }, 'image-edit').profile.id).toBe('agnes-image');
    expect(resolveProfileMeta({ providerId: 'agnes', model: 'agnes-image-2.1-flash' }, 'image-generate').kind).toBe('default');
    expect(resolveProfileMeta({ providerId: 'siliconflow', model: 'kolors' }, 'image-generate').profile.id).toBe('openai-image');
    expect(() => resolveProfileMeta({ providerId: 'siliconflow', model: 'kolors' }, 'image-edit')).toThrow(/不支持.*换绑/);
  });

  it('embed/rerank/tts/asr：openai → 默认实现；agnes 绑定 → 明确报错（不发未知请求）', () => {
    const features: MMFeature[] = ['embed', 'rerank', 'tts', 'asr'];
    for (const f of features) {
      const m = resolveProfileMeta({ providerId: 'siliconflow', model: 'bge-m3' }, f);
      expect(m.kind).toBe('default');
      expect(() => resolveProfileMeta({ providerId: 'agnes', model: 'agnes-2.5-flash' }, f)).toThrow(/不支持/);
    }
  });
});

// ---------- 2. 视频 profile：VideoTaskResult / mode 探测 / 帧数钳制 ----------

describe('agnes 2.5 视频 profile', () => {
  it('创建 → 轮询 → 返回 videoId/taskId/model/implementation/queryUrl；进度上报 video_id', async () => {
    stubAgnesVideoFlow({ model: 'agnes-video-2.5-flash' });
    const settings = setVideoModel(agnesSettings(), 'agnes-video-2.5-flash');
    const progress: string[] = [];
    const out = await videoGenerateTool.execute({ prompt: '一只猫', seconds: '5', pollIntervalMs: 1 }, toolCtx(settings, progress));
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
    // 独立模型名避免与其他用例共享探测缓存
    stubAgnesVideoFlow({ model: 'agnes-video-2.5-probe-a', createFails: 1 });
    const settings = setVideoModel(agnesSettings(), 'agnes-video-2.5-probe-a');
    await videoGenerateTool.execute({ prompt: 'x', pollIntervalMs: 1 }, toolCtx(settings));
    const createBodies = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/videos')).map((c) => JSON.parse(c.body));
    expect(createBodies.map((b) => b.mode)).toEqual(['text', 'ti2vid']);

    calls = [];
    stubAgnesVideoFlow({ model: 'agnes-video-2.5-probe-a' });
    await videoGenerateTool.execute({ prompt: 'y', pollIntervalMs: 1 }, toolCtx(setVideoModel(agnesSettings(), 'agnes-video-2.5-probe-a')));
    const retryBodies = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/videos')).map((c) => JSON.parse(c.body));
    expect(retryBodies.map((b) => b.mode)).toEqual(['ti2vid']);
  });

  it('请求体：2.5 格式携带 seconds/mode/size=720P/aspect_ratio', async () => {
    stubAgnesVideoFlow({ model: 'agnes-video-2.5-body' });
    await videoGenerateTool.execute({ prompt: 'x', seconds: '8', aspectRatio: '9:16', pollIntervalMs: 1 }, toolCtx(setVideoModel(agnesSettings(), 'agnes-video-2.5-body')));
    const body = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/videos'))!.body);
    expect(body).toMatchObject({ model: 'agnes-video-2.5-body', seconds: '8', size: '720P', aspect_ratio: '9:16' });
    expect(typeof body.mode).toBe('string');
  });
});

describe('agnes v2.0 视频 profile', () => {
  it('旧格式请求体：width/height/num_frames/frame_rate；num_frames 满足 8n+1 且 ≤441', async () => {
    stubFetch([
      {
        test: (url, method) => method === 'POST' && url.endsWith('/videos'),
        respond: () => jsonResponse({ id: 'task_v2', video_id: 'video_v2', status: 'queued' }),
      },
      { test: (url, method) => method === 'GET' && url.includes('/agnesapi'), respond: () => jsonResponse({ status: 'completed', metadata: { url: 'https://cdn.example.com/v2.mp4' } }) },
      { test: (url) => url.startsWith('https://cdn.example.com/'), respond: () => new Response(new Uint8Array([1]), { status: 200 }) },
    ]);
    await videoGenerateTool.execute({ prompt: 'x', seconds: '5.5', aspectRatio: '9:16', pollIntervalMs: 1 }, toolCtx(setVideoModel(agnesSettings(), 'agnes-video-v2.0')));
    const body = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/videos'))!.body);
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

// ---------- 3. 富输出：工具返回对象（模型只收文本，图片/文件落 part） ----------

describe('富输出链路（对象返回）', () => {
  it('图像生成：返回 richOutput 对象（含 images dataUrl + files），text 不含 base64', async () => {
    stubFetch([
      { test: (url, method) => method === 'POST' && url.endsWith('/images/generations'), respond: () => jsonResponse({ data: [{ b64_json: 'QUJD' }] }) },
    ]);
    const out = await imageGenerateTool.execute({ prompt: '一朵花', size: '2K' }, toolCtx(agnesSettings()));
    expect(isRichToolOutput(out)).toBe(true);
    const rich = out as { text: string; images: { dataUrl: string }[]; files: { kind: string }[] };
    expect(rich.images[0]!.dataUrl).toBe('data:image/png;base64,QUJD');
    expect(rich.files[0]!.kind).toBe('image');
    expect(rich.text).not.toContain('QUJD');
    expect(rich.text).toContain('已生成 1 张图片');
  });

  it('能力未适配：tts 绑定 agnes 模型 → 统一报错且 fetch 未被调用', async () => {
    stubFetch([]);
    const settings = agnesSettings();
    settings.bindings = settings.bindings.map((b) => (b.capability === 'tts' ? { ...b, modelId: 'agnes-video-2.5' } : b));
    await expect(ttsTool.execute({ text: '你好' }, toolCtx(settings))).rejects.toThrow(/语音合成（TTS）当前不支持.*agnes-video-2.5/);
    expect(calls.length).toBe(0);
  });
});
