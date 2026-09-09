/** MCP 客户端注册表（I9）：懒连接 / 双传输（stdio + HTTP）/ 工具包装 / 错误隔离。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolDef } from '../tools/types.js';
import { loadMcpConfig, serverTransport, type McpConfig, type McpServerConfig } from './config.js';

const CLIENT_INFO = { name: 'czagent', version: '0.1.0' };
const RECONNECT_COOLDOWN_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

interface McpEntry {
  client: Client;
  /** 包装后的工具（server 内全部工具） */
  tools: ToolDef[];
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** MCP 工具 id 的服务器前缀：`mcp_<sanitize(server)>_`（脚本 ctx.use 门控/懒加载按前缀归属服务器，I19） */
export function mcpServerPrefix(server: string): string {
  return `mcp_${sanitize(server)}_`;
}

/** MCP 工具结果（content 数组）→ 纯文本 */
function contentToText(content: unknown): string {
  const arr = Array.isArray(content) ? content : [];
  const parts = arr.map((c) => {
    const item = c as { type?: string; text?: string };
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    return `[${item.type ?? 'unknown'} 内容已省略]`;
  });
  return parts.join('\n') || '（无输出）';
}

export class McpRegistry {
  /** server 名 → 连接完成后的 entry（null = 最近一次失败） */
  private readonly clients = new Map<string, Promise<McpEntry | null>>();
  /** 最近一次连接失败时间（冷却期内不重试，避免每轮 spawn） */
  private readonly failedAt = new Map<string, number>();
  private readonly configs = new Map<string, McpServerConfig>();

  /** 拉取 MCP 工具（每 server 懒连接；单 server 失败只影响自身）；servers 为允许名单，缺省=全部配置 */
  async getTools(cwd: string, globalDir?: string, servers?: string[]): Promise<ToolDef[]> {
    let config: McpConfig;
    try {
      config = loadMcpConfig(cwd, globalDir);
    } catch {
      return [];
    }
    const out: ToolDef[] = [];
    for (const [name, cfg] of Object.entries(config)) {
      if (servers && !servers.includes(name)) continue;
      this.configs.set(name, cfg);
      const entry = await this.ensure(name, cfg);
      if (!entry) continue;
      out.push(...entry.tools);
    }
    return out;
  }

  /** 调用 MCP 工具（signal 可中断；错误 reject 给模型自纠） */
  async callTool(server: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const cfg = this.configs.get(server);
    if (!cfg) throw new Error(`MCP server "${server}" 未配置`);
    const entry = await this.ensure(server, cfg);
    if (!entry) throw new Error(`MCP server "${server}" 不可用（连接失败）`);
    const res = await entry.client.callTool({ name: toolName, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
      signal,
      timeout: CALL_TIMEOUT_MS,
    });
    const text = contentToText(res.content);
    if (res.isError) throw new Error(text || 'MCP 工具执行错误');
    return text;
  }

  /** 关闭全部连接（应用退出时调用） */
  async close(): Promise<void> {
    for (const p of this.clients.values()) {
      try {
        const entry = await p;
        await entry?.client.close();
      } catch {
        // 关闭失败忽略
      }
    }
    this.clients.clear();
    this.failedAt.clear();
  }

  /** 连接测试（独立临时客户端，不进入缓存；返回工具名清单或错误） */
  async testConnection(cfg: McpServerConfig): Promise<{ ok: boolean; tools: string[]; error?: string }> {
    let client: Client | undefined;
    try {
      if (serverTransport('test', cfg) === 'http') {
        client = await connectHttpWithFallback(cfg as Extract<McpServerConfig, { url: string }>);
      } else {
        const stdio = cfg as Extract<McpServerConfig, { command: string }>;
        client = new Client(CLIENT_INFO);
        await client.connect(new StdioClientTransport({ command: stdio.command, args: stdio.args ?? [], env: { ...(stdio.env ?? {}) } as Record<string, string> }));
      }
      const listed = await client.listTools();
      return { ok: true, tools: (listed.tools ?? []).map((t) => t.name) };
    } catch (e) {
      return { ok: false, tools: [], error: String((e as Error)?.message ?? e) };
    } finally {
      await client?.close().catch(() => {});
    }
  }

  /** 懒连接 + 缓存；失败进入冷却期（30s）后允许重建 */
  private async ensure(name: string, cfg: McpServerConfig): Promise<McpEntry | null> {
    const cached = this.clients.get(name);
    if (cached) return cached;
    const failed = this.failedAt.get(name);
    if (failed !== undefined && Date.now() - failed < RECONNECT_COOLDOWN_MS) return null;
    this.failedAt.delete(name);

    const p = this.connect(name, cfg)
      .then((entry) => {
        this.clients.set(name, Promise.resolve(entry));
        return entry;
      })
      .catch(() => {
        this.failedAt.set(name, Date.now());
        this.clients.delete(name);
        return null;
      });
    this.clients.set(name, p);
    return p;
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<McpEntry> {
    let client: Client;
    if (serverTransport(name, cfg) === 'http') {
      // Streamable HTTP 优先；老 server（仅 SSE）自动回退
      client = await connectHttpWithFallback(cfg as Extract<McpServerConfig, { url: string }>);
    } else {
      client = new Client(CLIENT_INFO);
      await client.connect(this.stdioTransport(cfg as Extract<McpServerConfig, { command: string }>));
    }
    const listed = await client.listTools();
    const tools: ToolDef[] = (listed.tools ?? []).map((t) => ({
      id: `mcp_${sanitize(name)}_${sanitize(t.name)}`,
      description: `[MCP:${name}] ${t.description ?? ''}`.trim(),
      inputSchema: (t.inputSchema as ToolDef['inputSchema']) ?? { type: 'object', properties: {} },
      execute: async (input: unknown, ctx: { signal?: AbortSignal }) => {
        return this.callTool(name, t.name, input, ctx?.signal);
      },
    }));
    return { client, tools };
  }
  private stdioTransport(cfg: Extract<McpServerConfig, { command: string }>): StdioClientTransport {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...(cfg.env ?? {}) } as Record<string, string>,
    });
  }
}

/** HTTP 连接：Streamable 失败回退 SSE（老 server 兼容） */
export async function connectHttpWithFallback(cfg: Extract<McpServerConfig, { url: string }>): Promise<Client> {
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} } }));
    return client;
  } catch {
    await client.close().catch(() => {});
    const sse = new Client(CLIENT_INFO);
    await sse.connect(new SSEClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} } }));
    return sse;
  }
}
