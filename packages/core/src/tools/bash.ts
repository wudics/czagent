import { spawn } from '@lydell/node-pty';
import type { ToolDef, ToolContext } from './types.js';

export let bashTimeoutMs = 60_000;
/** 默认命令超时（毫秒） */
export const BASH_TIMEOUT_MS = bashTimeoutMs;
/** 测试用：动态调整命令超时 */
export function setBashTimeoutMs(ms: number): void {
  bashTimeoutMs = ms;
}
const MAX_OUTPUT = 30_000;

/** 平台感知的描述：引导模型生成当前系统（Windows→PowerShell / 其它→POSIX）的命令 */
const BASH_DESCRIPTION =
  process.platform === 'win32'
    ? '在会话工作目录下执行 Windows PowerShell 命令。当前系统为 Windows：请使用 PowerShell 语法（Get-ChildItem/dir、Get-Content/type、Remove-Item/del、Select-String/findstr、Test-Path，路径用反斜杠 \\）；不要使用 Linux 命令（ls/cat/rm/grep/touch）。'
    : '在会话工作目录下执行 bash 命令。当前系统为 Linux/macOS：请使用 POSIX 语法（ls/cat/rm/grep/touch、Select-String，路径用 /）。';

interface ShellSpec {
  shell: string;
  buildArgs: (cmd: string) => string[];
}

function shellSpec(): ShellSpec {
  if (process.platform === 'win32') {
    return {
      shell: 'powershell.exe',
      buildArgs: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', cmd],
    };
  }
  return {
    shell: 'bash',
    buildArgs: (cmd) => ['-c', cmd],
  };
}

/** 剥离 ANSI 转义序列（颜色/光标/标题等），保留纯文本 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

export const bashTool: ToolDef = {
  id: 'bash',
  description: BASH_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令' } },
    required: ['command'],
  },
  async execute(input, ctx: ToolContext) {
    const command = String(input.command ?? '');
    if (!command.trim()) throw new Error('缺少 command 参数');

    const { shell, buildArgs } = shellSpec();
    const pty = spawn(shell, buildArgs(command), {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: ctx.cwd,
      env: { ...process.env, TERM: 'xterm-color' } as Record<string, string>,
    });

    let output = '';
    let timedOut = false;
    let resolveExit: ((code: number) => void) | undefined;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    pty.onData((data) => {
      if (output.length < MAX_OUTPUT) output += stripAnsi(data);
    });
    pty.onExit(({ exitCode }) => resolveExit?.(exitCode));
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        pty.kill();
      } catch {
        // ignore
      }
      // 兜底：即使 kill 未触发 onExit，也释放退出等待
      resolveExit?.(0);
    }, bashTimeoutMs);
    const onAbort = (): void => {
      try {
        pty.kill();
      } catch {
        // ignore
      }
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const exitCode = await exitPromise;

    clearTimeout(timeout);
    ctx.signal.removeEventListener('abort', onAbort);
    if (timedOut) throw new Error(`命令执行超时（${bashTimeoutMs / 1000}s）`);

    const clipped = output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + '\n…（输出已截断）' : output;
    return `exitCode: ${exitCode}\n\n${clipped}`;
  },
};
