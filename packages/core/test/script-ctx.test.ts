import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEntryChild } from '../src/script/child.js';
import type { ScriptAgentRunOptions } from '../src/script/types.js';

/** 端到端跑一次子进程桥（I18 ctx 增强）：ctx.settings 注入/冻结、per-call 超时透传、agent.run opts 透传 */
describe('runEntryChild ctx（I18 增强）', () => {
  it('ctx.settings 注入且冻结、ctx.tools timeoutMs 透传、agent.run opts 透传', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'czagent-ctx-'));
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(
      join(dir, 'entry.ts'),
      `export default async function main(ctx: any) {
  const out: any = {};
  out.general = ctx.settings.general;
  out.sessionId = ctx.session.id;
  try {
    await ctx.tools.hang({ a: 1 }, { timeoutMs: 300 });
    out.timeout = 'no-timeout';
  } catch (e: any) {
    out.timeout = String((e && e.message) || e);
  }
  const agentResult = await ctx.agent.run('hi', { agent: 'build', maxSteps: 3, mcpServers: ['srv1'], tools: ['read'] });
  const frozen = Object.isFrozen(ctx.settings.general) && Object.isFrozen(ctx.settings);
  const sessionFrozen = Object.isFrozen(ctx.session);
  return { out, agentResult, frozen, sessionFrozen };
}
`,
      'utf8',
    );

    let seenTool: { tool: string; input: unknown; timeoutMs?: number } | null = null;
    let seenAgentOpts: ScriptAgentRunOptions | undefined;
    const value = (await runEntryChild({
      entryPath: join(dir, 'entry.ts'),
      cwd: dir,
      runDir: join(dir, 'run'),
      sessionMeta: { id: 's-1', cwd: dir, model: 'm', mode: 'chat' },
      settingsGeneral: { scriptTimeoutMinutes: 2 } as Parameters<typeof runEntryChild>[0]['settingsGeneral'],
      handlers: {
        onTool: (tool, input, timeoutMs) => {
          seenTool = { tool, input, timeoutMs };
          return new Promise((_, rej) => {
            setTimeout(() => rej(new Error(`工具调用超时（${Math.round((timeoutMs ?? 0) / 1000)}s）：${tool}`)), 300);
          });
        },
        onAgentRun: (prompt, opts) => {
          seenAgentOpts = opts;
          expect(prompt).toBe('hi');
          return Promise.resolve('agent-ok');
        },
        onLog: () => {},
        onAsk: () => Promise.resolve('allow'),
      },
    })) as { out: { general: { scriptTimeoutMinutes?: number }; sessionId: string; timeout: string }; agentResult: string; frozen: boolean; sessionFrozen: boolean };

    expect(value.out.sessionId).toBe('s-1');
    expect(value.out.general.scriptTimeoutMinutes).toBe(2);
    expect(value.out.timeout).toContain('工具调用超时');
    expect(value.agentResult).toBe('agent-ok');
    expect(value.frozen).toBe(true);
    expect(value.sessionFrozen).toBe(true);
    expect(seenTool).not.toBeNull();
    expect(seenTool!.tool).toBe('hang');
    expect(seenTool!.input).toEqual({ a: 1 });
    expect(seenTool!.timeoutMs).toBe(300);
    expect(seenAgentOpts).toEqual({ agent: 'build', maxSteps: 3, mcpServers: ['srv1'], tools: ['read'] });

    rmSync(dir, { recursive: true, force: true });
  });
});
