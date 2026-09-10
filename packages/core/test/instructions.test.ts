/** P1 测试：AGENTS.md 指令加载（缓存/截断/缺失）+ system prompt 组装（BASE_PROMPT 拼接/子代理附加段）。 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInstructions, renderProjectInstructions } from '../src/instructions.js';
import { composeSystemPrompt, SUB_AGENT_ADDENDUM } from '../src/settings-defaults.js';

const touch = (file: string, content: string, mtime?: Date): void => {
  writeFileSync(file, content, 'utf8');
  if (mtime) utimesSync(file, mtime, mtime);
};

describe('loadProjectInstructions', () => {
  it('读取 AGENTS.md（trim）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'czagent-agents-'));
    touch(join(dir, 'AGENTS.md'), '  本项目用 pnpm，不要用 npm。\n');
    expect(await loadProjectInstructions(dir)).toBe('本项目用 pnpm，不要用 npm。');
    rmSync(dir, { recursive: true, force: true });
  });

  it('缺失/空文件 → 空串', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'czagent-agents-'));
    expect(await loadProjectInstructions(dir)).toBe('');
    touch(join(dir, 'AGENTS.md'), '   \n');
    expect(await loadProjectInstructions(dir)).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('超过 10k 字符截断并带提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'czagent-agents-'));
    touch(join(dir, 'AGENTS.md'), '长'.repeat(12_000));
    const out = await loadProjectInstructions(dir);
    expect(out.length).toBeLessThan(10_100);
    expect(out).toContain('已截断');
    rmSync(dir, { recursive: true, force: true });
  });

  it('缓存命中：mtime+size 未变返回缓存；变更后刷新', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'czagent-agents-'));
    const file = join(dir, 'AGENTS.md');
    touch(file, 'v1');
    const cache = new Map();
    expect(await loadProjectInstructions(dir, cache)).toBe('v1');
    // 同 mtime+size 直接命中缓存（即使文件内容被外部改掉——stat 未变就不重读）
    touch(file, 'v2-external');
    const stat = await import('node:fs/promises').then((m) => m.stat(file));
    cache.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, content: 'v1' });
    expect(await loadProjectInstructions(dir, cache)).toBe('v1');
    // mtime 变化 → 刷新
    touch(file, 'v2', new Date(Date.now() + 5000));
    expect(await loadProjectInstructions(dir, cache)).toBe('v2');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('renderProjectInstructions', () => {
  it('空指令 → 空串（不产生空标签）', () => {
    expect(renderProjectInstructions('')).toBe('');
    expect(renderProjectInstructions('  ')).toBe('');
  });

  it('非空 → project_instructions 标签 + 优先级说明', () => {
    const out = renderProjectInstructions('用 pnpm');
    expect(out).toContain('<project_instructions>');
    expect(out).toContain('优先级高于一般行为约定');
    expect(out).toContain('用 pnpm');
    expect(out.trimEnd().endsWith('</project_instructions>')).toBe(true);
  });
});

describe('composeSystemPrompt', () => {
  it('BASE + agent 拼接（双换行分隔）', () => {
    const out = composeSystemPrompt({ systemPrompt: '你是 Build 模式。' });
    expect(out.startsWith(composeSystemPrompt())).toBe(true);
    expect(out.endsWith('你是 Build 模式。')).toBe(true);
    expect(out).toContain('# 执行风格');
    expect(out).toContain('# 工具使用策略');
  });

  it('无 agent / 空提示词 → 仅 BASE', () => {
    const base = composeSystemPrompt();
    expect(base).toContain('以只读约束为准');
    expect(composeSystemPrompt({ systemPrompt: '  ' })).toBe(base);
    expect(composeSystemPrompt(undefined)).toBe(base);
  });

  it('子代理附加段关键要素', () => {
    expect(SUB_AGENT_ADDENDUM).toContain('子代理');
    expect(SUB_AGENT_ADDENDUM).toContain('不要向用户提问');
    expect(SUB_AGENT_ADDENDUM).toContain('自包含的最终报告');
  });
});
