import { spawn } from '@lydell/node-pty';
import type { ToolDef, ToolContext } from './types.js';

export let bashTimeoutMs = 120_000;
/** 默认命令超时（毫秒） */
export const BASH_TIMEOUT_MS = bashTimeoutMs;
/** 测试用：动态调整默认超时 */
export function setBashTimeoutMs(ms: number): void {
  bashTimeoutMs = ms;
}
const MAX_OUTPUT = 30_000;

/** 平台感知的描述：引导模型生成当前系统（Windows→PowerShell / 其它→POSIX）的命令 */
const BASH_DESCRIPTION =
  process.platform === 'win32'
    ? `在会话工作目录下执行 Windows PowerShell 命令，无需 cd（默认就在工作目录）。当前系统为 Windows：请使用 PowerShell 语法（Get-ChildItem/dir、Get-Content/type、Remove-Item/del、Select-String/findstr、Test-Path，路径用反斜杠 \\）；不要使用 Linux 命令（ls/cat/rm/grep/touch）。
用法：默认超时 120000ms，耗时命令（下载/安装/构建）请显式传更大的 timeout 参数（毫秒）；不支持交互式输入，交互式命令会挂起直到超时，请用非交互参数（-Confirm:$false 等）；输出超过约 30k 字符会被截断。
多条命令：互相独立的命令可在同一条回复中并行多次调用；有依赖时用分号加条件判断串联（如 cmd1; if ($?) { cmd2 }）；仅顺序执行但不关心前序失败时用分号。
优先用专用工具：读文件用 read、搜索内容用 grep、按名找文件用 glob、改文件用 edit/write，不要用 bash 的文件操作替代。`
    : `在会话工作目录下执行 bash 命令，无需 cd（默认就在工作目录）。当前系统为 Linux/macOS：请使用 POSIX 语法（ls/cat/rm/grep/touch，路径用 /）。
用法：默认超时 120000ms，耗时命令（下载/安装/构建）请显式传更大的 timeout 参数（毫秒）；不支持交互式输入，交互式命令会挂起直到超时，请用非交互参数（--yes、-q 等）；输出超过约 30k 字符会被截断。
多条命令：互相独立的命令可在同一条回复中并行多次调用；有依赖时用 && 串联（如 mkdir out && cp a out/）；仅顺序执行但不关心前序失败时用 ;；不要用换行分隔命令（引号字符串内可以）。
优先用专用工具：读文件用 read、搜索内容用 grep、按名找文件用 glob、改文件用 edit/write，不要用 bash 的文件操作替代。`;

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
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: {
        type: 'number',
        description: '本次命令的超时毫秒数（正整数）。默认 120000；下载/安装/构建等耗时命令请显式传更大的 timeout',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx: ToolContext) {
    const command = String(input.command ?? '');
    if (!command.trim()) throw new Error('缺少 command 参数');
    const rawTimeout = input.timeout;
    let timeoutMs = bashTimeoutMs;
    if (rawTimeout !== undefined && rawTimeout !== null && rawTimeout !== '') {
      const n = Number(rawTimeout);
      if (!Number.isInteger(n) || n <= 0) throw new Error('timeout 必须为正整数（毫秒）');
      timeoutMs = n;
    }

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
    let aborted = false;
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
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      try {
        pty.kill();
      } catch {
        // ignore
      }
      resolveExit?.(0);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const exitCode = await exitPromise;

    clearTimeout(timeout);
    ctx.signal.removeEventListener('abort', onAbort);
    // 超时/中止不抛错：返回已捕获输出 + 元信息，让模型据此决定加大 timeout 重试或放弃
    const clipped = output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + '\n…（输出已截断）' : output;
    const shownCode = timedOut ? 124 : aborted ? 130 : exitCode;
    let text = `exitCode: ${shownCode}\n\n${clipped}`;
    const meta: string[] = [];
    if (timedOut) {
      meta.push(
        `命令超时（执行 ${timeoutMs / 1000}s 后被中止）。若命令确实需要更长时间且非等待交互输入，请调用时传更大的 timeout 参数重试。`,
      );
    }
    if (aborted) meta.push('用户中止了命令');
    if (meta.length > 0) text += `\n\n<shell_metadata>\n${meta.join('\n')}\n</shell_metadata>`;
    return text;
  },
};
