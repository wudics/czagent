/** bash 超时参数化测试：参数校验、超时返回部分输出（不抛错）、用户中止、正常路径回归。 */
import { describe, expect, it } from 'vitest';
import { bashTool } from '../src/tools/bash.js';
import type { ToolContext } from '../src/tools/types.js';

function makeCtx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return { cwd: process.cwd(), signal } as unknown as ToolContext;
}

describe('bash timeout 参数', () => {
  it('timeout 非正整数/非数字 → 报错', async () => {
    await expect(bashTool.execute({ command: 'echo hi', timeout: 0 }, makeCtx())).rejects.toThrow('timeout 必须为正整数');
    await expect(bashTool.execute({ command: 'echo hi', timeout: -100 }, makeCtx())).rejects.toThrow('timeout 必须为正整数');
    await expect(bashTool.execute({ command: 'echo hi', timeout: 1.5 }, makeCtx())).rejects.toThrow('timeout 必须为正整数');
    await expect(bashTool.execute({ command: 'echo hi', timeout: 'abc' }, makeCtx())).rejects.toThrow('timeout 必须为正整数');
  });

  it('正常命令：exitCode 0 且无 shell_metadata', async () => {
    const out = String(await bashTool.execute({ command: 'echo hello' }, makeCtx()));
    expect(out).toContain('exitCode: 0');
    expect(out).toContain('hello');
    expect(out).not.toContain('shell_metadata');
  });

  it('超时不抛错：返回 exitCode 124、部分输出与重试提示', async () => {
    const out = String(await bashTool.execute({ command: 'echo start-marker; sleep 5', timeout: 400 }, makeCtx()));
    expect(out).toContain('exitCode: 124');
    expect(out).toContain('start-marker');
    expect(out).toContain('shell_metadata');
    expect(out).toContain('更大的 timeout 参数');
  }, 10_000);

  it('用户中止：返回 exitCode 130 与中止提示', async () => {
    const controller = new AbortController();
    const p = bashTool.execute({ command: 'sleep 10', timeout: 60_000 }, makeCtx(controller.signal));
    setTimeout(() => controller.abort(), 200);
    const out = String(await p);
    expect(out).toContain('exitCode: 130');
    expect(out).toContain('用户中止了命令');
  }, 10_000);
});
