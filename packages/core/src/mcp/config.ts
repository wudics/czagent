/** MCP 配置：全局 ~/.czagent/mcp.json + 工作区 <cwd>/.czagent/mcp.json（工作区覆盖同名 server）。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 全局配置目录解析：优先 env（测试隔离用），默认 ~/.czagent */
export function defaultGlobalDir(): string {
  return process.env.CZAGENT_GLOBAL_MCP_DIR || join(homedir(), '.czagent');
}

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = (McpStdioConfig | McpHttpConfig) & { type?: 'stdio' | 'http'; /** 全局启用（I13）：false = 默认不加载；agent 可 'on' 覆盖 */ enabled?: boolean };

/** 该 server 全局是否启用（未显式设 false = 启用） */
export function isMcpServerEnabled(cfg: McpServerConfig): boolean {
  return cfg.enabled !== false;
}

export type McpConfig = Record<string, McpServerConfig>;

/**
 * 计算某 agent 的 MCP 生效服务器名单（049）：默认跟随全局启停（`enabled !== false` 即并入）；
 * agent 显式 'off' 排除、'on' 顶回全局已关闭的服务器。
 *
 * 与工具加载链**解耦**：agent 的 `toolOverrides` / 遗留 `tools` 白名单不影响 MCP 生效范围
 * （旧语义借 `isAgentAllOpen` 判定，而矩阵首次编辑即物化 `load:true` 会把全开 agent 翻成受限，
 *  导致 MCP 静默清零）。
 */
export function resolveMcpServerNames(config: McpConfig, agentMcp?: Record<string, 'on' | 'off'>): string[] {
  return Object.keys(config).filter((name) => {
    const o = agentMcp?.[name];
    if (o === 'off') return false;
    if (o === 'on') return true;
    return isMcpServerEnabled(config[name]!);
  });
}

/** 判定传输类型：显式 type 优先；否则有 command → stdio，有 url → http */
export function serverTransport(name: string, cfg: McpServerConfig): 'stdio' | 'http' {
  if (cfg.type) return cfg.type;
  if ('command' in cfg && typeof cfg.command === 'string') return 'stdio';
  if ('url' in cfg && typeof cfg.url === 'string') return 'http';
  throw new Error(`MCP server "${name}" 配置无效：缺少 command（stdio）或 url（http）`);
}

/** 读取两层 mcp.json（工作区覆盖全局）；缺失/坏 JSON → 跳过该层，不阻塞 */
export function loadMcpConfig(cwd: string, globalDir = defaultGlobalDir()): McpConfig {
  const merged: McpConfig = {};
  for (const p of [join(globalDir, 'mcp.json'), join(cwd, '.czagent', 'mcp.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
      for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
        merged[name] = cfg;
      }
    } catch {
      // 文件缺失 / JSON 坏 → 跳过该层
    }
  }
  return merged;
}

export interface McpLayerEntry {
  name: string;
  config: McpServerConfig;
  source: 'global' | 'workspace';
}

export interface McpLayers {
  /** 合并后的条目（含来源，工作区覆盖同名全局条目） */
  entries: McpLayerEntry[];
  globalPath: string;
  workspacePath: string;
}

/** 读取两层配置并保留来源标记（设置页 MCP Tab 用；cwd 决定工作区层位置） */
export function readMcpLayers(cwd: string, globalDir = defaultGlobalDir()): McpLayers {
  const globalPath = join(globalDir, 'mcp.json');
  const workspacePath = join(cwd, '.czagent', 'mcp.json');
  const global: Record<string, McpServerConfig> = {};
  const workspace: Record<string, McpServerConfig> = {};
  for (const [p, target] of [
    [globalPath, global],
    [workspacePath, workspace],
  ] as const) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
      Object.assign(target, parsed.mcpServers ?? {});
    } catch {
      // 缺失 / 坏 JSON → 该层为空
    }
  }
  const entries: McpLayerEntry[] = [
    ...Object.entries(global).map(([name, config]) => ({ name, config, source: 'global' as const })),
    ...Object.entries(workspace)
      .filter(([name]) => !(name in global))
      .map(([name, config]) => ({ name, config, source: 'workspace' as const })),
  ];
  return { entries, globalPath, workspacePath };
}

/** 写全局层 mcp.json（设置页增删改的落点；工作区层不受影响） */
export function writeGlobalMcpConfig(config: McpConfig, globalDir = defaultGlobalDir()): void {
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, 'mcp.json'), JSON.stringify({ mcpServers: config }, null, 2), 'utf8');
}
