/** 脚本子进程运行器（I14.1）：esbuild bundle → node 子进程 → stdio JSON-RPC 桥承载 ctx。
 *  - fs/模块不设限（信任工作区代码，等同 npm run）；第三方与 ESM-only 包经 bundle 可用；
 *  - stop/超时：向子进程发 abort 帧，5s 宽限后 SIGKILL（真正终止，修复 vm 时代"杀不掉"边界）；
 *  - 限制：stdout 被协议占用（console/ctx.log 已接管为日志流）；ctx 与返回值需可 JSON 序列化。 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ChildRunOptions, ScriptAgentRunOptions } from './types.js';

/** 最小 esbuild 表面（避免 core 依赖 esbuild 类型） */
interface EsbuildLike {
  build(opts: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[] }>;
}

/** 跨环境 require 锚点：打包后为 CJS（__filename 可用），vitest 为 ESM（import.meta.url） */
function runtimeRequire(): NodeRequire {
  if (typeof __filename !== 'undefined') return createRequire(__filename);
  return createRequire(import.meta.url);
}

/** 子进程前置垫片：实现 ctx 与帧协议（__SESSION_JSON__ 由宿主替换） */
const PRELUDE = `
var __seq = 0, __aborted = false, __pending = {};
function __send(frame, after) {
  var line;
  try { line = JSON.stringify(frame); } catch (e) {
    try { frame = { t: frame.t, id: frame.id, line: '（无法序列化输出）' }; line = JSON.stringify(frame); } catch (e2) { return; }
  }
  try { process.stdout.write(line + "\\n", after); } catch (e) { if (after) after(); }
}
function __fmt(args) {
  var out = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (typeof a === 'string') { out.push(a); continue; }
    try { out.push(JSON.stringify(a) === undefined ? String(a) : JSON.stringify(a)); } catch (e) { out.push(String(a)); }
  }
  return out.join(' ');
}
console.log = function () { __send({ t: 'log', line: __fmt(arguments) }); };
console.info = console.log;
console.warn = function () { __send({ t: 'log', line: '[warn] ' + __fmt(arguments) }); };
console.error = function () { __send({ t: 'log', line: '[error] ' + __fmt(arguments) }); };
var __ctrl = new AbortController();
function __rejectPending(msg) {
  var ids = Object.keys(__pending);
  for (var i = 0; i < ids.length; i++) { try { __pending[ids[i]].rej(new Error(msg)); } catch (e) {} }
  __pending = {};
}
function __call(payload) {
  return new Promise(function (res, rej) {
    if (__aborted) { rej(new Error('已停止')); return; }
    var id = String(++__seq);
    payload.id = id;
    __pending[id] = { res: res, rej: rej };
    __send(payload);
  });
}
function __handleFrame(f) {
  if (!f || typeof f !== 'object') return;
  if (f.t === 'abort') { __aborted = true; try { __ctrl.abort(); } catch (e) {} __rejectPending('已停止'); return; }
  if (f.id != null && __pending[f.id]) {
    var p = __pending[f.id]; delete __pending[f.id];
    if (f.ok) p.res(f.value); else p.rej(new Error(String(f.error || '宿主调用失败')));
  }
}
var __buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  __buf += chunk;
  var i;
  while ((i = __buf.indexOf('\\n')) >= 0) {
    var line = __buf.slice(0, i).trim();
    __buf = __buf.slice(i + 1);
    if (!line) continue;
    var f = null;
    try { f = JSON.parse(line); } catch (e) { __send({ t: 'log', line: line }); continue; }
    __handleFrame(f);
  }
});
process.on('uncaughtException', function (e) { __send({ t: 'fail', message: '未捕获异常：' + String((e && e.message) || e) }, function () { process.exit(1); }); });
process.on('unhandledRejection', function (e) { __send({ t: 'fail', message: '未处理的 Promise 拒绝：' + String((e && e.message) || e) }, function () { process.exit(1); }); });
var __ctx = {
  session: __SESSION_JSON__,
  settings: __SETTINGS_JSON__,
  tools: typeof Proxy === 'undefined' ? {} : new Proxy({}, { get: function (_t, name) { if (typeof name !== 'string') return undefined; return function (input, callOpts) { var t = callOpts && typeof callOpts === 'object' ? callOpts.timeoutMs : undefined; return __call({ t: 'tool', tool: name, input: input === undefined ? null : input, timeoutMs: typeof t === 'number' && isFinite(t) && t > 0 ? Math.round(t) : null }); }; } }),
  agent: { run: function (prompt, opts) { return __call({ t: 'agent', prompt: String(prompt || ''), opts: opts || null }); } },
  log: function () { __send({ t: 'log', line: __fmt(arguments) }); },
  ask: function (req) { return __call({ t: 'ask', tool: req && req.tool, args: (req && req.args) || {} }); },
  signal: __ctrl.signal,
};
Object.freeze(__ctx);
try { Object.freeze(__ctx.session); Object.freeze(__ctx.settings); Object.freeze(__ctx.settings.general); } catch (e) {}
`;

/** 用户 bundle 之后的收尾胶水：调 default(ctx) 并回传 result/fail */
const GLUE = `
;(function () {
  var __mainFn = (typeof module !== 'undefined' && module.exports) || undefined;
  if (__mainFn && __mainFn.default) __mainFn = __mainFn.default;
  Promise.resolve()
    .then(function () {
      if (typeof __mainFn !== 'function') throw new Error('脚本必须导出 default 函数：export default async function main(ctx) { ... }');
      return __mainFn(__ctx);
    })
    .then(function (v) {
      __send({ t: 'result', value: v === undefined ? null : v }, function () { process.exit(0); });
    })
    .catch(function (e) {
      __send({ t: 'fail', message: String((e && e.message) || e) }, function () { process.exit(1); });
    });
})();
`;

function replyTo(write: (frame: Record<string, unknown>) => void, id: unknown, ok: boolean, extra: Record<string, unknown>): void {
  write({ id, ok, ...extra });
}

/** 打包态解析 esbuild 平台二进制：require.resolve 会返回 asar 内路径（spawn 无法执行），
 *  需重定向到 app.asar.unpacked。candidates 逐一 existsSync 校验，找不到返回 null（保持默认行为）。 */
export function resolvePackagedEsbuildBin(
  filename: string | undefined,
  resourcesPath: string | undefined,
  platform: string,
  arch: string,
): string | null {
  const bin = platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  // esbuild 平台包内二进制位置（见 esbuild lib/main.js pkgAndSubpathForCurrentPlatform）：
  // win32 在包根（esbuild.exe），unix-like 在 bin/ 子目录——漏掉 bin/ 会解析失败 → spawn ENOTDIR
  const sub = join(
    'node_modules',
    '@esbuild',
    `${platform}-${arch}`,
    platform === 'win32' ? bin : join('bin', bin),
  );
  const candidates: string[] = [];
  // filename 形如 .../resources/app.asar/out/main/index.js：截断到 app.asar 为止（不带 out/main/...）
  const m = typeof filename === 'string' ? filename.match(/^(.*?app\.asar)/) : null;
  if (m) candidates.push(join(m[1]! + '.unpacked', sub));
  // Electron main 进程兜底：process.resourcesPath 即 .../resources
  if (typeof resourcesPath === 'string' && resourcesPath) candidates.push(join(resourcesPath, 'app.asar.unpacked', sub));
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function bundleEntry(opts: ChildRunOptions): Promise<string> {
  if (!process.env.ESBUILD_BINARY_PATH) {
    const found = resolvePackagedEsbuildBin(
      typeof __filename === 'string' ? __filename : undefined,
      (process as { resourcesPath?: string }).resourcesPath,
      process.platform,
      process.arch,
    );
    if (found) process.env.ESBUILD_BINARY_PATH = found;
  }
  const esbuild = runtimeRequire()('esbuild') as EsbuildLike;
  const build = await esbuild.build({
    absWorkingDir: opts.cwd,
    entryPoints: [relative(opts.cwd, opts.entryPath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: 'inline',
    write: false,
    logLevel: 'silent',
  });
  const code = build.outputFiles?.[0]?.text;
  if (!code) throw new Error('脚本打包失败：esbuild 无输出');
  return code;
}

/** 运行一次入口脚本；resolve = 脚本返回值，reject = 用户代码/超时/停止/崩溃错误 */
export async function runEntryChild(opts: ChildRunOptions): Promise<unknown> {
  let bundled: string;
  try {
    bundled = await bundleEntry(opts);
  } catch (e) {
    const first = (e as { errors?: { text?: string }[] })?.errors?.[0]?.text;
    throw new Error(`脚本打包失败：${first ?? String((e as Error)?.message ?? e)}`);
  }

  mkdirSync(opts.runDir, { recursive: true });
  const file = join(opts.runDir, `entry-${Date.now()}.cjs`);
  // 占位符用函数替换：JSON 内的 $ 序列不会被 String.replace 当作特殊模式展开
  const source =
    PRELUDE.replace('__SESSION_JSON__', () => JSON.stringify(opts.sessionMeta))
      .replace('__SETTINGS_JSON__', () => JSON.stringify({ general: opts.settingsGeneral })) +
    '\n' +
    bundled +
    '\n' +
    GLUE;
  writeFileSync(file, source, 'utf8');

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string | undefined>;
  delete env.NODE_OPTIONS;

  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0;

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stderrTail = '';
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
      rmSync(file, { force: true });
      fn();
    };

    const child = spawn(process.execPath, ['--enable-source-maps', file], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const writeFrame = (frame: Record<string, unknown>): void => {
      try {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch {
        // 管道已断：交给 exit 处理
      }
    };

    const forceKill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    };

    const beginStop = (reason: string): void => {
      writeFrame({ t: 'abort' });
      graceTimer = setTimeout(() => {
        forceKill();
        finish(() => reject(new Error(reason)));
      }, 5_000);
      graceTimer.unref?.();
    };

    const onExternalAbort = (): void => {
      if (settled) return;
      beginStop('脚本未响应停止请求（已强制结束）');
    };

    if (opts.signal) {
      if (opts.signal.aborted) onExternalAbort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        writeFrame({ t: 'abort' });
        graceTimer = setTimeout(forceKill, 5_000);
        graceTimer.unref?.();
        finish(() => reject(new Error(`脚本执行超时（${Math.round(timeoutMs / 1000)}s）`)));
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let f: Record<string, unknown> | null = null;
        try {
          f = JSON.parse(line) as Record<string, unknown>;
        } catch {
          opts.handlers.onLog(line);
          continue;
        }
        if (!f || typeof f !== 'object') continue;
        const t = f.t as string;
        if (t === 'log') opts.handlers.onLog(String(f.line ?? ''));
        else if (t === 'tool') {
          const id = f.id;
          const timeoutMs = typeof f.timeoutMs === 'number' && f.timeoutMs > 0 ? f.timeoutMs : undefined;
          Promise.resolve()
            .then(() => opts.handlers.onTool(String(f!.tool), f!.input, timeoutMs))
            .then((v) => replyTo(writeFrame, id, true, { value: v ?? null }), (e) => replyTo(writeFrame, id, false, { error: String((e as Error)?.message ?? e) }));
        } else if (t === 'agent') {
          const id = f.id;
          const aopts = f.opts ? (f.opts as ScriptAgentRunOptions) : undefined;
          Promise.resolve()
            .then(() => opts.handlers.onAgentRun(String(f!.prompt ?? ''), aopts))
            .then((v) => replyTo(writeFrame, id, true, { value: v ?? '' }), (e) => replyTo(writeFrame, id, false, { error: String((e as Error)?.message ?? e) }));
        } else if (t === 'ask') {
          const id = f.id;
          Promise.resolve()
            .then(() => opts.handlers.onAsk(String(f!.tool), f!.args))
            .then((v) => replyTo(writeFrame, id, true, { value: v }), (e) => replyTo(writeFrame, id, false, { error: String((e as Error)?.message ?? e) }));
        } else if (t === 'result') finish(() => resolve(f.value));
        else if (t === 'fail') finish(() => reject(new Error(String(f.message ?? '脚本执行失败'))));
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('error', (e) => finish(() => reject(new Error(`脚本子进程启动失败：${String((e as Error)?.message ?? e)}`))));
    child.on('close', (code) => {
      if (settled) return;
      const tail = stderrTail.trim() ? `\n${stderrTail.trim().slice(-500)}` : '';
      finish(() => reject(new Error(`脚本进程异常退出（code ${code}）${tail}`)));
    });
  });
}
