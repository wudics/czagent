import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEntryChild } from '../src/script/child.js';
import type { ScriptAgentRunOptions, ScriptUseOverrides } from '../src/script/types.js';
import { resolveAgentRef } from '../src/node/session-manager.js';
import type { AgentDef } from '../src/provider.js';
import { skillTool } from '../src/tools/skill.js';
import type { ToolContext } from '../src/tools/types.js';

/** 端到端跑一次子进程桥（I18 ctx 增强 / I19 ctx.use）：ctx.settings 注入/冻结、per-call 超时透传、agent.run opts 与 ctx.use 透传 */
describe('runEntryChild ctx（I18/I19 增强）', () => {
  it('ctx.settings 注入且冻结、ctx.tools timeoutMs 透传、agent.run opts 与 ctx.use 透传', { timeout: 30_000 }, async () => {
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
  await ctx.use({ mcpServers: ['fs'], skills: ['pdf'] });
  await ctx.use({ skills: null });
  await ctx.use();
  const frozen = Object.isFrozen(ctx.settings.general) && Object.isFrozen(ctx.settings);
  const sessionFrozen = Object.isFrozen(ctx.session);
  const useIsFunction = typeof ctx.use === 'function';
  return { out, agentResult, frozen, sessionFrozen, useIsFunction };
}
`,
      'utf8',
    );

    let seenTool: { tool: string; input: unknown; timeoutMs?: number } | null = null;
    let seenAgentOpts: ScriptAgentRunOptions | undefined;
    const seenUse: ScriptUseOverrides[] = [];
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
        onUse: (patch) => {
          seenUse.push(JSON.parse(JSON.stringify(patch)));
        },
        onLog: () => {},
        onAsk: () => Promise.resolve('allow'),
      },
    })) as {
      out: { general: { scriptTimeoutMinutes?: number }; sessionId: string; timeout: string };
      agentResult: string;
      frozen: boolean;
      sessionFrozen: boolean;
      useIsFunction: boolean;
    };

    expect(value.out.sessionId).toBe('s-1');
    expect(value.out.general.scriptTimeoutMinutes).toBe(2);
    expect(value.out.timeout).toContain('工具调用超时');
    expect(value.agentResult).toBe('agent-ok');
    expect(value.frozen).toBe(true);
    expect(value.sessionFrozen).toBe(true);
    expect(value.useIsFunction).toBe(true);
    expect(seenTool).not.toBeNull();
    expect(seenTool!.tool).toBe('hang');
    expect(seenTool!.input).toEqual({ a: 1 });
    expect(seenTool!.timeoutMs).toBe(300);
    expect(seenAgentOpts).toEqual({ agent: 'build', maxSteps: 3, mcpServers: ['srv1'], tools: ['read'] });
    expect(seenUse).toEqual([{ mcpServers: ['fs'], skills: ['pdf'] }, { skills: null }, {}]);

    rmSync(dir, { recursive: true, force: true });
  });
});

/** agent 解析（I19）：id 精确 → name 精确 → 缺省 build；显式传入找不到抛错并列出可用项 */
describe('resolveAgentRef', () => {
  const agents: AgentDef[] = [
    { id: 'build', name: 'Build', description: '', systemPrompt: '', tools: [], permission: { allow: [], deny: [], ask: [] } },
    { id: 'plan', name: 'Plan', description: '', systemPrompt: '', tools: [], permission: { allow: [], deny: [], ask: [] } },
    { id: 'agent-x1', name: '猛男村村长', description: '', systemPrompt: '', tools: [], permission: { allow: [], deny: [], ask: [] } },
  ];

  it('缺省/空 → build', () => {
    expect(resolveAgentRef(agents)?.id).toBe('build');
    expect(resolveAgentRef(agents, '')?.id).toBe('build');
    expect(resolveAgentRef(agents, '  ')?.id).toBe('build');
  });

  it('id 与 name 均可命中（含中文 name）', () => {
    expect(resolveAgentRef(agents, 'plan')?.id).toBe('plan');
    expect(resolveAgentRef(agents, '猛男村村长')?.id).toBe('agent-x1');
    expect(resolveAgentRef(agents, 'agent-x1')?.id).toBe('agent-x1');
  });

  it('显式传入找不到 → 抛错并列出可用 agent', () => {
    expect(() => resolveAgentRef(agents, 'nope')).toThrowError(/未找到 agent：nope/);
    expect(() => resolveAgentRef(agents, 'nope')).toThrowError(/Build\(build\)/);
    expect(() => resolveAgentRef(agents, 'nope')).toThrowError(/猛男村村长\(agent-x1\)/);
  });
});

/** skill 工具 allowedSkills（I19）：白名单权威覆盖全局 disabledSkills */
describe('skillTool allowedSkills', () => {
  const mkCtx = (dir: string, allowedSkills?: string[]): ToolContext =>
    ({
      sessionId: 's',
      cwd: dir,
      settings: { general: { disabledSkills: ['skill-aaa'] } },
      gateway: {},
      signal: new AbortController().signal,
      ...(allowedSkills ? { allowedSkills } : {}),
    }) as unknown as ToolContext;

  it('白名单覆盖全局禁用：名单内可用、名单外拒绝；缺省跟随全局', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'czagent-skill-'));
    const skillsDir = join(dir, '.czagent', 'skills');
    mkdirSync(join(skillsDir, 'aaa'), { recursive: true });
    mkdirSync(join(skillsDir, 'bbb'), { recursive: true });
    writeFileSync(join(skillsDir, 'aaa', 'SKILL.md'), '---\nname: skill-aaa\ndescription: a\n---\nAAA-BODY', 'utf8');
    writeFileSync(join(skillsDir, 'bbb', 'SKILL.md'), '---\nname: skill-bbb\ndescription: b\n---\nBBB-BODY', 'utf8');

    // 权威覆盖：skill-aaa 虽被全局禁用，白名单点名即可用；skill-bbb 不在名单内被拒
    expect(await skillTool.execute({ name: 'skill-aaa' }, mkCtx(dir, ['skill-aaa']))).toContain('AAA-BODY');
    await expect(skillTool.execute({ name: 'skill-bbb' }, mkCtx(dir, ['skill-aaa']))).rejects.toThrowError(/未找到技能：skill-bbb/);

    // 缺省：跟随全局 disabledSkills（skill-aaa 被禁、skill-bbb 可用）
    await expect(skillTool.execute({ name: 'skill-aaa' }, mkCtx(dir))).rejects.toThrowError(/未找到技能：skill-aaa/);
    expect(await skillTool.execute({ name: 'skill-bbb' }, mkCtx(dir))).toContain('BBB-BODY');

    rmSync(dir, { recursive: true, force: true });
  });
});
