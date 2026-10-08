/**
 * MCP 生效名单（049）测试：
 * resolveMcpServerNames 与工具加载链解耦 + 两层 mcp.json 合并/容错/传输判定。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentDef } from '../src/provider.js';
import {
  isMcpServerEnabled,
  loadMcpConfig,
  resolveMcpServerNames,
  serverTransport,
  writeGlobalMcpConfig,
  type McpConfig,
} from '../src/mcp/config.js';
import { mcpServerPrefix } from '../src/mcp/registry.js';

const CONFIG: McpConfig = {
  alpha: { command: 'npx', args: ['alpha'] },
  beta: { command: 'npx', args: ['beta'] },
  gamma: { url: 'https://example.com/mcp/gamma', enabled: false },
};

/** 工具矩阵物化后的 build agent（toolOverrides 全为 load:true）——旧语义下会被判为「受限 agent」 */
const MATERIALIZED_BUILD: AgentDef = {
  id: 'build',
  name: 'Build',
  description: '',
  systemPrompt: '',
  tools: [],
  permission: { allow: [], deny: [], ask: [] },
  toolOverrides: { read: { load: true, mode: 'allow' }, bash: { load: true, mode: 'ask' } },
};

/** 写 JSON 文件（自动建父目录） */
const writeJson = (file: string, data: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
};

describe('resolveMcpServerNames', () => {
  it('无 agent 偏离 → 并入全局启用的服务器，排除 enabled:false', () => {
    expect(resolveMcpServerNames(CONFIG)).toEqual(['alpha', 'beta']);
  });

  it('agent toolOverrides 物化（load:boolean）不再清空 MCP —— 049 回归点', () => {
    expect(resolveMcpServerNames(CONFIG, MATERIALIZED_BUILD.mcp)).toEqual(['alpha', 'beta']);
  });

  it("agent 显式 'off' → 排除该服务器，其余照常", () => {
    expect(resolveMcpServerNames(CONFIG, { alpha: 'off' })).toEqual(['beta']);
  });

  it("agent 显式 'on' → 顶回全局 enabled:false", () => {
    expect(resolveMcpServerNames(CONFIG, { gamma: 'on' })).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('agent 未点名的全局关闭服务器不带入', () => {
    expect(resolveMcpServerNames(CONFIG, { alpha: 'on' })).not.toContain('gamma');
  });

  it('agent 无 mcp 字段（undefined）→ 跟随全局', () => {
    expect(resolveMcpServerNames(CONFIG, undefined)).toEqual(['alpha', 'beta']);
  });

  it('空配置 → 空名单', () => {
    expect(resolveMcpServerNames({})).toEqual([]);
  });

  it('plan agent（遗留 tools 白名单 + toolOverrides）同样并入启用服务器', () => {
    const plan: AgentDef = {
      ...MATERIALIZED_BUILD,
      id: 'plan',
      tools: ['plan', 'plan-exit'],
      mcp: { beta: 'off' },
    };
    expect(resolveMcpServerNames(CONFIG, plan.mcp)).toEqual(['alpha']);
  });
});

describe('mcp/config 辅助', () => {
  it('isMcpServerEnabled：未设 false 即启用', () => {
    expect(isMcpServerEnabled({ command: 'x' })).toBe(true);
    expect(isMcpServerEnabled({ command: 'x', enabled: true })).toBe(true);
    expect(isMcpServerEnabled({ command: 'x', enabled: false })).toBe(false);
  });

  it('serverTransport：显式 type 优先，否则 command→stdio / url→http', () => {
    expect(serverTransport('a', { command: 'x' })).toBe('stdio');
    expect(serverTransport('b', { url: 'https://x' })).toBe('http');
    expect(serverTransport('c', { url: 'https://x', type: 'stdio' })).toBe('stdio');
    expect(() => serverTransport('d', {} as never)).toThrow(/配置无效/);
  });

  it('mcpServerPrefix：工具 id 归属前缀', () => {
    expect(mcpServerPrefix('weknora')).toBe('mcp_weknora_');
    expect(mcpServerPrefix('a.b')).toBe('mcp_a_b_');
  });

  it('两层 mcp.json 合并：工作区覆盖同名全局；缺失/坏 JSON 跳过不阻塞', () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'czagent-mcp-g-'));
    const cwd = mkdtempSync(join(tmpdir(), 'czagent-mcp-w-'));
    try {
      writeGlobalMcpConfig({ alpha: { command: 'global-alpha' }, beta: { command: 'global-beta' } }, globalDir);
      writeJson(join(cwd, '.czagent', 'mcp.json'), {
        mcpServers: { beta: { command: 'ws-beta' }, gamma: { url: 'https://ws/gamma' } },
      });
      const merged = loadMcpConfig(cwd, globalDir);
      expect(Object.keys(merged).sort()).toEqual(['alpha', 'beta', 'gamma']);
      expect((merged.beta as { command: string }).command).toBe('ws-beta');
      expect(resolveMcpServerNames(merged)).toEqual(['alpha', 'beta', 'gamma']);

      // 坏 JSON → 跳过该层，其余不受影响
      writeFileSync(join(cwd, '.czagent', 'mcp.json'), '{ 坏 JSON', 'utf8');
      const afterBreak = loadMcpConfig(cwd, globalDir);
      expect(Object.keys(afterBreak).sort()).toEqual(['alpha', 'beta']);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('全局层文件不存在 → 空配置（不抛错）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'czagent-mcp-none-'));
    try {
      expect(loadMcpConfig(empty, join(empty, 'nope'))).toEqual({});
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
