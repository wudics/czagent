import { app, BrowserWindow } from 'electron';
import type { Details } from 'electron';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildRelaunchArgs,
  isGpuCompositingEnabled,
  isGpuMarkerUsable,
  isVirtualGpuVendor,
  isVirtualMachineDmi,
  parseGpuProbeOutput,
  shouldFallbackStartup,
  type GpuMarker,
  type GpuMode,
  type GpuProbeResult,
} from './gpu-mode-core';

const PROBE_LINE_PREFIX = 'GPU_PROBE:';
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_WINDOW_READY_TIMEOUT_MS = 3_000;
const PROBE_SETTLE_MS = 500;
const PROBE_GPU_INFO_TIMEOUT_MS = 1_500;
const GPU_FAILURE_STARTUP_WINDOW_MS = 20_000;

const GPU_FAILURE_REASONS = new Set<string>([
  'crashed',
  'launch-failed',
  'abnormal-exit',
  'integrity-failure',
]);

export interface GpuInitResult {
  mode: GpuMode;
  reason: string;
  markerPath: string;
}

/** 避免 marker.reason 每次启动都多一层 `cached:`，只保留一个稳定前缀。 */
function cachedReason(reason: string): string {
  return `cached:${reason.replace(/^(?:cached:)+/, '')}`;
}

function getUserDataDir(): string {
  try {
    return app.getPath('userData');
  } catch {
    try {
      return join(app.getPath('appData'), 'czagent');
    } catch {
      return tmpdir();
    }
  }
}

export function getGpuMarkerPath(): string {
  return join(getUserDataDir(), 'gpu-mode.json');
}

export function logGpu(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.info(`[czagent] ${message}`);
  try {
    const logDir = join(getUserDataDir(), 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'gpu.log'), `${line}\n`, 'utf8');
  } catch {
    // 诊断日志写不进去不影响启动
  }
}

export function readGpuMarker(): GpuMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(getGpuMarkerPath(), 'utf8')) as Record<string, unknown>;
    if (parsed['schema'] !== 1) return null;

    const mode = parsed['mode'];
    const appVersion = parsed['appVersion'];
    const electronVersion = parsed['electronVersion'];
    const reason = parsed['reason'];
    const updatedAt = parsed['updatedAt'];

    if (mode !== 'hardware' && mode !== 'software') return null;
    if (
      typeof appVersion !== 'string' ||
      typeof electronVersion !== 'string' ||
      typeof reason !== 'string' ||
      typeof updatedAt !== 'number'
    ) {
      return null;
    }

    const marker: GpuMarker = {
      schema: 1,
      appVersion,
      electronVersion,
      mode,
      reason,
      updatedAt,
    };
    if (typeof parsed['startupPending'] === 'boolean') marker.startupPending = parsed['startupPending'];
    if (typeof parsed['startupAt'] === 'number') marker.startupAt = parsed['startupAt'];
    return marker;
  } catch {
    return null;
  }
}

function persistGpuMarker(marker: GpuMarker): void {
  const file = getGpuMarkerPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tempFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    renameSync(tempFile, file);
  } catch {
    // 标记只是优化；写失败时下次继续探测
  }
}

export function setGpuMarker(
  mode: GpuMode,
  reason: string,
  extra: Partial<Pick<GpuMarker, 'startupPending' | 'startupAt'>> = {},
): GpuMarker {
  const marker: GpuMarker = {
    schema: 1,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    mode,
    reason,
    updatedAt: Date.now(),
    ...extra,
  };
  persistGpuMarker(marker);
  return marker;
}

function markHardwareStartup(reason: string): void {
  setGpuMarker('hardware', reason, { startupPending: true, startupAt: Date.now() });
}

/** 窗口真正显示后清除 startupPending；否则下次启动会自动回退软件渲染。 */
export function markGpuStartupSuccess(): void {
  const marker = readGpuMarker();
  if (!marker || marker.startupPending !== true) return;
  persistGpuMarker({ ...marker, startupPending: false, updatedAt: Date.now() });
}

/**
 * 窗口显示后核对一次实际合成状态。
 * 某些环境 GPU 进程初始化失败但 Chromium 仍能用软件合成把窗口显示出来；
 * 这时把 software 写进标记，保证下一次启动不再重复打 GPU 错误。
 */
export function recordRuntimeGpuStatus(mode: GpuMode): void {
  if (mode !== 'hardware' || process.platform !== 'linux' || !app.isPackaged) return;
  try {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    const compositing = status['gpu_compositing'];
    if (typeof compositing === 'string' && !isGpuCompositingEnabled(compositing)) {
      setGpuMarker('software', `runtime:gpu-compositing=${compositing}`);
      logGpu(
        `GPU degraded at runtime (gpu_compositing=${compositing}); software will be used next launch`,
      );
    }
  } catch (error) {
    logGpu(`runtime GPU status check failed: ${String(error)}`);
  }
}

export function applySoftwareRendering(): void {
  try {
    app.disableHardwareAcceleration();
  } catch (error) {
    logGpu(`disableHardwareAcceleration failed: ${String(error)}`);
  }
  app.commandLine.appendSwitch('disable-gpu');
}

export function isGpuProbeMode(): boolean {
  return process.argv.includes('--gpu-probe');
}

export function isGpuStatusMode(): boolean {
  return process.argv.includes('--gpu-status');
}

export function isVirtualMachine(): boolean {
  const files = [
    '/sys/class/dmi/id/product_name',
    '/sys/class/dmi/id/sys_vendor',
    '/sys/class/dmi/id/board_vendor',
    '/sys/class/dmi/id/bios_vendor',
  ];
  const values: string[] = [];

  for (const file of files) {
    try {
      values.push(readFileSync(file, 'utf8'));
    } catch {
      // 非 Linux 或 DMI 不可读时忽略
    }
  }
  return isVirtualMachineDmi(values);
}

export function hasUsableRenderNode(): boolean {
  try {
    return readdirSync('/dev/dri').some((name) => name.startsWith('renderD'));
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function failedProbe(reason: string): GpuProbeResult {
  return {
    ok: false,
    reason,
    gpuCompositing: 'unknown',
    opengl: 'unknown',
    webgl: 'unknown',
    vendors: [],
    virtualGpu: false,
  };
}

async function probeGpuInProcess(): Promise<GpuProbeResult> {
  let gpuGone: string | undefined;
  const onChildProcessGone = (_event: unknown, details: Details): void => {
    if (details.type === 'GPU') gpuGone = details.reason;
  };
  app.on('child-process-gone', onChildProcessGone);

  let probeWindow: BrowserWindow | undefined;
  try {
    probeWindow = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const win = probeWindow;

    const ready = new Promise<void>((resolve) => {
      win.once('ready-to-show', () => resolve());
    });
    void win.loadURL('data:text/html,<title>czagent-gpu-probe</title>').catch(() => {
      // ready 超时后会继续读取状态
    });

    await Promise.race([ready, delay(PROBE_WINDOW_READY_TIMEOUT_MS)]);
    await delay(PROBE_SETTLE_MS);

    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    const readStatus = (key: string): string => {
      const value = status[key];
      return typeof value === 'string' ? value : 'unknown';
    };
    const gpuCompositing = readStatus('gpu_compositing');
    const opengl = readStatus('opengl');
    const webgl = readStatus('webgl');

    let vendors: number[] = [];
    let gpuInfoError: string | undefined;
    try {
      const info = (await withTimeout(app.getGPUInfo('basic'), PROBE_GPU_INFO_TIMEOUT_MS)) as {
        gpuDevice?: Array<{ active?: boolean; vendorId?: number }>;
      };
      vendors = (info.gpuDevice ?? [])
        .filter((device) => device.active !== false)
        .map((device) => device.vendorId)
        .filter((vendor): vendor is number => typeof vendor === 'number' && Number.isFinite(vendor));
    } catch (error) {
      gpuInfoError = String(error).slice(0, 300);
    }

    const virtualGpu = vendors.some(isVirtualGpuVendor);
    const compositingEnabled = isGpuCompositingEnabled(gpuCompositing);
    const ok = compositingEnabled && gpuGone === undefined && !virtualGpu;

    let reason: string;
    if (gpuGone !== undefined) {
      reason = `probe:gpu-child=${gpuGone}`;
    } else if (virtualGpu) {
      reason = `probe:virtual-gpu=${vendors.map((vendor) => `0x${vendor.toString(16)}`).join(',')}`;
    } else {
      reason = `probe:gpu-compositing=${gpuCompositing}`;
    }

    return {
      ok,
      reason,
      gpuCompositing,
      opengl,
      webgl,
      vendors,
      virtualGpu,
      ...(gpuGone !== undefined ? { gpuGone } : {}),
      ...(gpuInfoError !== undefined ? { gpuInfoError } : {}),
    };
  } finally {
    app.off('child-process-gone', onChildProcessGone);
    if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy();
  }
}

function writeProbeResult(result: GpuProbeResult): void {
  process.stdout.write(`${PROBE_LINE_PREFIX}${JSON.stringify(result)}\n`, () => {
    app.exit(result.ok ? 0 : 2);
  });
}

/** --gpu-probe 子进程入口：只做探测，不加载数据库/主窗口。 */
export function runGpuProbeMode(): void {
  const probeDir = process.env['CZAGENT_GPU_PROBE_DIR'];
  if (probeDir) {
    try {
      app.setPath('userData', probeDir);
    } catch {
      // 使用默认 userData 也能工作
    }
  }

  app
    .whenReady()
    .then(async () => {
      try {
        writeProbeResult(await probeGpuInProcess());
      } catch (error) {
        writeProbeResult(failedProbe(`probe:error:${String(error).slice(0, 300)}`));
      }
    })
    .catch((error) => {
      writeProbeResult(failedProbe(`probe:when-ready-error:${String(error).slice(0, 300)}`));
    });
}

function runProbeChild(): GpuProbeResult {
  if (process.platform !== 'linux') return failedProbe('probe:unsupported-platform');

  let probeDir: string;
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'czagent-gpu-probe-'));
  } catch (error) {
    return failedProbe(`probe:temp-dir-error:${String(error).slice(0, 300)}`);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, CZAGENT_GPU_PROBE_DIR: probeDir };
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_ENABLE_LOGGING'];

  const isDefaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true;
  const args = isDefaultApp ? [app.getAppPath(), '--gpu-probe'] : ['--gpu-probe'];

  try {
    const child = spawnSync(process.execPath, args, {
      env,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = typeof child.stdout === 'string' ? child.stdout : '';
    const parsed = parseGpuProbeOutput(stdout);
    if (parsed) return parsed;

    const stderr = typeof child.stderr === 'string' ? child.stderr : '';
    const detail = child.error
      ? child.error.message
      : `exit=${child.status ?? 'null'}${child.signal ? `,signal=${child.signal}` : ''}`;
    const stderrTail = stderr
      .replace(/\s+/g, ' ')
      .trim()
      .slice(-200);
    return failedProbe(`probe:spawn:${detail}${stderrTail ? `,stderr=${stderrTail}` : ''}`);
  } catch (error) {
    return failedProbe(`probe:spawn-error:${String(error).slice(0, 300)}`);
  } finally {
    try {
      rmSync(probeDir, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响启动
    }
  }
}

/**
 * 在 app ready 之前决定渲染模式。
 * - 物理机：先尝试 GPU
 * - 虚拟机/虚拟 GPU/无 render node：软件渲染
 * - 探测失败/超时/GPU 子进程崩溃：软件渲染
 * - 结果写入 marker，后续启动直接复用
 */
export function initGpuMode(): GpuInitResult {
  const appVersion = app.getVersion();
  const electronVersion = process.versions.electron ?? 'unknown';
  const markerPath = getGpuMarkerPath();
  const disableByCli =
    process.argv.includes('--disable-gpu') || process.env['CZAGENT_DISABLE_GPU'] === '1';
  const forceByCli =
    process.argv.includes('--force-gpu') || process.env['CZAGENT_FORCE_GPU'] === '1';
  const enableByCli =
    process.argv.includes('--enable-gpu') || process.env['CZAGENT_ENABLE_GPU'] === '1';

  if (disableByCli) {
    applySoftwareRendering();
    setGpuMarker('software', 'cli:disable-gpu');
    logGpu('GPU mode: software (cli:disable-gpu)');
    return { mode: 'software', reason: 'cli:disable-gpu', markerPath };
  }

  if (forceByCli) {
    markHardwareStartup('cli:force-gpu');
    logGpu('GPU mode: hardware (cli:force-gpu)');
    return { mode: 'hardware', reason: 'cli:force-gpu', markerPath };
  }

  const marker = readGpuMarker();
  const cached = !enableByCli && isGpuMarkerUsable(marker, appVersion, electronVersion);

  if (cached) {
    if (marker.mode === 'software') {
      applySoftwareRendering();
      const reason = cachedReason(marker.reason);
      logGpu(`GPU mode: software (${reason})`);
      return { mode: 'software', reason, markerPath };
    }

    if (shouldFallbackStartup(marker)) {
      applySoftwareRendering();
      setGpuMarker('software', 'cached:previous-startup-failed');
      logGpu('GPU mode: software (previous hardware startup did not show a window)');
      return { mode: 'software', reason: 'cached:previous-startup-failed', markerPath };
    }

    const reason = cachedReason(marker.reason);
    markHardwareStartup(reason);
    logGpu(`GPU mode: hardware (${reason})`);
    return { mode: 'hardware', reason, markerPath };
  }

  // 开发态不自动探测，避免影响日常开发；打包后完整启用。
  if (process.platform !== 'linux' || !app.isPackaged) {
    logGpu(`GPU mode: hardware (dev-or-unsupported-platform, ${process.platform})`);
    return { mode: 'hardware', reason: 'dev-or-unsupported-platform', markerPath };
  }

  const vm = isVirtualMachine();
  if (vm && !hasUsableRenderNode()) {
    applySoftwareRendering();
    setGpuMarker('software', 'vm:no-render-node');
    logGpu('GPU mode: software (virtual machine without render node)');
    return { mode: 'software', reason: 'vm:no-render-node', markerPath };
  }

  logGpu('GPU mode: probing hardware acceleration...');
  const probe = runProbeChild();
  const vmWithoutGpuInfo = vm && probe.vendors.length === 0;
  const useGpu = probe.ok && !vmWithoutGpuInfo;

  if (useGpu) {
    markHardwareStartup(probe.reason);
    logGpu(`GPU mode: hardware (${probe.reason})`);
    return { mode: 'hardware', reason: probe.reason, markerPath };
  }

  applySoftwareRendering();
  const reason = probe.ok && vmWithoutGpuInfo ? 'vm:no-gpu-vendor' : probe.reason;
  setGpuMarker('software', reason);
  logGpu(`GPU mode: software (${reason})`);
  return { mode: 'software', reason, markerPath };
}

/** 运行时兜底：GPU 进程在启动阶段崩溃时，写软件标记并只重启一次。 */
export function installGpuFailureHandler(mode: GpuMode): void {
  if (process.platform !== 'linux') return;

  const startedAt = Date.now();
  let relaunching = false;

  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return;

    logGpu(`GPU process gone: reason=${details.reason} exit=${details.exitCode}`);
    if (mode === 'software' || !GPU_FAILURE_REASONS.has(details.reason)) return;

    if (Date.now() - startedAt > GPU_FAILURE_STARTUP_WINDOW_MS) {
      setGpuMarker('software', `gpu-child-${details.reason}:runtime`);
      logGpu('GPU failure after startup window; software will be used on next launch');
      return;
    }

    if (relaunching) return;
    relaunching = true;

    setGpuMarker('software', `gpu-child-${details.reason}`);
    const args = buildRelaunchArgs(process.argv);
    logGpu(`GPU failure during startup; relaunching with software rendering`);
    app.relaunch({ args });
    app.exit(0);
  });
}

/** --gpu-status：打印当前判定，不启动数据库和主窗口。 */
export function printGpuStatus(): void {
  const appVersion = app.getVersion();
  const electronVersion = process.versions.electron ?? 'unknown';
  const marker = readGpuMarker();
  const enableByCli =
    process.argv.includes('--enable-gpu') || process.env['CZAGENT_ENABLE_GPU'] === '1';
  const disableByCli =
    process.argv.includes('--disable-gpu') || process.env['CZAGENT_DISABLE_GPU'] === '1';
  const forceByCli =
    process.argv.includes('--force-gpu') || process.env['CZAGENT_FORCE_GPU'] === '1';
  const vm = isVirtualMachine();
  const renderNode = hasUsableRenderNode();

  const lines: string[] = [];

  if (disableByCli) {
    lines.push('mode: software', 'reason: cli:disable-gpu');
  } else if (forceByCli) {
    lines.push('mode: hardware', 'reason: cli:force-gpu');
  } else if (!enableByCli && isGpuMarkerUsable(marker, appVersion, electronVersion)) {
    lines.push(
      `mode: ${marker.mode}`,
      `reason: ${cachedReason(marker.reason)}`,
      `startupPending: ${marker.startupPending === true}`,
    );
  } else if (process.platform !== 'linux') {
    lines.push('mode: hardware', 'reason: status:non-linux');
  } else if (vm && !renderNode) {
    lines.push('mode: software', 'reason: vm:no-render-node');
  } else {
    logGpu('GPU status: probing hardware acceleration...');
    const probe = runProbeChild();
    const vmWithoutGpuInfo = vm && probe.vendors.length === 0;
    const useGpu = probe.ok && !vmWithoutGpuInfo;
    lines.push(
      `mode: ${useGpu ? 'hardware' : 'software'}`,
      `reason: ${probe.ok && vmWithoutGpuInfo ? 'vm:no-gpu-vendor' : probe.reason}`,
      `gpu_compositing: ${probe.gpuCompositing}`,
      `opengl: ${probe.opengl}`,
      `webgl: ${probe.webgl}`,
      `vendors: ${probe.vendors.map((vendor) => `0x${vendor.toString(16)}`).join(',') || 'unknown'}`,
    );
  }

  lines.push(
    `marker: ${getGpuMarkerPath()}`,
    `app: ${appVersion}`,
    `electron: ${electronVersion}`,
    `platform: ${process.platform}`,
    `vm: ${vm}`,
    `renderNode: ${renderNode}`,
  );

  process.stdout.write(`${lines.join('\n')}\n`, () => {
    app.exit(0);
  });
}
