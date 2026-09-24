import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../src/provider.js';
import { websearchTool } from '../src/tools/websearch/websearch.js';
import { setFetchIntervalForTest } from '../src/tools/websearch/fetcher.js';
import type { ToolContext } from '../src/tools/types.js';

const BAIDU_HTML =
  '<li class="b_algo"><h2><a href="https://example.com/a">必应结果 A</a></h2><p>关于 widget 的说明</p></li>';
const BAIDU_AI_JSON = {
  request_id: 'r1',
  references: [
    { id: 1, title: '千帆结果一', url: 'https://a.one/x', snippet: '关于 widget 的中文解释' },
    { id: 2, title: '千帆结果二', url: 'https://b.two/y', content: 'fallback content widget' },
    { id: 1, title: '千帆结果一重复', url: 'https://a.one/x', snippet: '去重应丢弃我' },
  ],
};
const EXA_JSON = {
  requestId: 'e1',
  results: [{ title: 'Exa Alpha', url: 'https://exa.one', summary: 'neural widget findings' }],
};

function makeSettings(patch: (ws: NonNullable<Settings['general']['websearch']>) => void): Settings {
  const settings = {
    general: {
      websearch: { engines: ['bing', 'baidu', 'so360', 'sogou'], maxResults: 8 },
    },
  } as unknown as Settings;
  patch(settings.general.websearch!);
  return settings;
}

interface Call {
  url: string;
  init?: { body?: string };
}

function stubFetch(handler: (url: string, body: unknown) => { status: number; json?: unknown; html?: string }): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as { url: string }).url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init: init ? { body: init.body ? String(init.body) : undefined } : undefined });
    const res = handler(url, body);
    return {
      ok: res.status === 200,
      status: res.status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : '') },
      async json() {
        return res.json;
      },
      async text() {
        return res.html ?? JSON.stringify(res.json);
      },
      async arrayBuffer() {
        return new TextEncoder().encode(res.html ?? JSON.stringify(res.json)).buffer;
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function run(settings: Settings, query: string): Promise<string> {
  const ctx = { settings, signal: new AbortController().signal } as unknown as ToolContext;
  return String(await websearchTool.execute({ query }, ctx));
}

beforeEach(() => setFetchIntervalForTest(0));
afterEach(() => vi.unstubAllGlobals());

describe('websearch AI 检索级联（百度千帆 → Exa → HTML 兜底）', () => {
  it('baidu-ai 开启且有 key：优先命中，不发 HTML 抓取；按 URL 去重', async () => {
    const stub = stubFetch((url) =>
      url.includes('qianfan.baidubce.com') ? { status: 200, json: BAIDU_AI_JSON } : { status: 200, html: BAIDU_HTML },
    );
    try {
      const text = await run(
        makeSettings((ws) => {
          ws.ai = { baidu: { enabled: true, apiKey: 'b-key' } };
        }),
        'widget 是什么',
      );
      expect(text).toContain('引擎：baidu-ai');
      expect(text).toContain('千帆结果一');
      expect(text).toContain('https://a.one/x');
      expect(text).toContain('fallback content widget'); // snippet 缺失回退 content
      expect(text).not.toContain('重复'); // URL 去重
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0]!.url).toContain('qianfan.baidubce.com');
    } finally {
      stub.restore();
    }
  });

  it('请求构造：query 72 字符按权截断、top_k/numResults=maxResults；不参与 HTML 缓存', async () => {
    const stub = stubFetch((url) => (url.includes('qianfan') ? { status: 200, json: BAIDU_AI_JSON } : { status: 200, json: EXA_JSON }));
    try {
      const long = '测'.repeat(50); // 100 权重 > 72 → 截到 36 个汉字
      await run(
        makeSettings((ws) => {
          ws.ai = { baidu: { enabled: true, apiKey: 'k' } };
          ws.maxResults = 12;
        }),
        long,
      );
      const body = JSON.parse(stub.calls[0]!.init!.body!) as {
        messages: { content: string }[];
        search_source: string;
        resource_type_filter: { type: string; top_k: number }[];
      };
      expect(body.messages[0]!.content).toHaveLength(36);
      expect(body.search_source).toBe('baidu_search_v2');
      expect(body.resource_type_filter[0]).toEqual({ type: 'web', top_k: 12 });
    } finally {
      stub.restore();
    }
  });

  it('baidu-ai 报错（402 额度尽）→ 级联 exa 成功', async () => {
    const stub = stubFetch((url) =>
      url.includes('qianfan') ? { status: 402, json: { error: 'out of credits', tag: 'NO_MORE_CREDITS' } } : { status: 200, json: EXA_JSON },
    );
    try {
      const text = await run(
        makeSettings((ws) => {
          ws.ai = { baidu: { enabled: true, apiKey: 'k' }, exa: { enabled: true, apiKey: 'x' } };
        }),
        'neural search',
      );
      expect(text).toContain('引擎：exa');
      expect(text).toContain('Exa Alpha');
      expect(stub.calls.some((c) => c.url.includes('api.exa.ai'))).toBe(true);
      expect(stub.calls.every((c) => !c.url.includes('cn.bing.com'))).toBe(true); // 不进 HTML 兜底
    } finally {
      stub.restore();
    }
  });

  it('开启但未填 key → 跳过该引擎；两个 AI 都跳过 → bing HTML 兜底', async () => {
    const stub = stubFetch((url) => (url.includes('cn.bing.com') ? { status: 200, html: BAIDU_HTML } : { status: 500 }));
    try {
      const text = await run(
        makeSettings((ws) => {
          ws.ai = { baidu: { enabled: true, apiKey: '  ' }, exa: { enabled: false, apiKey: 'x' } };
        }),
        'widget',
      );
      expect(text).toContain('引擎：bing');
      expect(stub.calls.every((c) => !c.url.includes('qianfan') && !c.url.includes('exa'))).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it('全部 AI 失败且 HTML 引擎不可用 → 明确失败提示不假装成功', async () => {
    const stub = stubFetch(() => ({ status: 500 }));
    try {
      const text = await run(
        makeSettings((ws) => {
          ws.ai = { baidu: { enabled: true, apiKey: 'k' }, exa: { enabled: true, apiKey: 'x' } };
        }),
        'widget',
      );
      expect(text).toContain('搜索不可用');
    } finally {
      stub.restore();
    }
  });
});
