export type GpuMode = 'hardware' | 'software';

export interface GpuMarker {
  schema: 1;
  appVersion: string;
  electronVersion: string;
  mode: GpuMode;
  reason: string;
  updatedAt: number;
  /** hardware 启动过程中会置为 true；窗口真正显示后清除，用于识别启动阶段崩溃。 */
  startupPending?: boolean;
  /** 本次 hardware 启动开始时间，配合 startupPending 防止无限重试。 */
  startupAt?: number;
}

export interface GpuProbeResult {
  ok: boolean;
  reason: string;
  gpuCompositing: string;
  opengl: string;
  webgl: string;
  vendors: number[];
  virtualGpu: boolean;
  gpuGone?: string;
  gpuInfoError?: string;
}

/** 30 天后重新探测一次，避免驱动更新后永远停留在旧结论。 */
export const GPU_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 上次 hardware 启动在 5 分钟内没有成功显示窗口，下一次直接走软件渲染。 */
export const GPU_STARTUP_PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * 常见虚拟 GPU 的 PCI vendor id。
 * 这些设备通常只提供 GLES2，或依赖 llvmpipe，默认走软件渲染更稳。
 */
const VIRTUAL_GPU_VENDORS = new Set<number>([
  0x1013, // Cirrus Logic
  0x1234, // QEMU
  0x1414, // Microsoft Hyper-V
  0x15ad, // VMware
  0x1ab8, // Parallels
  0x1af4, // virtio
  0x1b36, // QXL
  0x5333, // S3
  0x80ee, // VirtualBox
]);

const VM_DMI_MARKERS = [
  'vmware',
  'virtualbox',
  'innotek',
  'qemu',
  'kvm',
  'virtual machine',
  'xen',
  'parallels',
  'bochs',
  'openstack',
  'hyper-v',
  'bhyve',
  'q35',
];

export function isVirtualGpuVendor(vendorId: number): boolean {
  return VIRTUAL_GPU_VENDORS.has(vendorId);
}

/** Chromium 可能返回 enabled / enabled_on / enabled_force_on 等几种“已启用”状态。 */
export function isGpuCompositingEnabled(value: string): boolean {
  return value.startsWith('enabled');
}

/** 从 DMI 字符串判断是否虚拟机；单独出现 Microsoft Corporation 不算，避免误伤物理机。 */
export function isVirtualMachineDmi(values: readonly string[]): boolean {
  return values.some((value) => {
    const normalized = value.toLowerCase();
    return VM_DMI_MARKERS.some((marker) => normalized.includes(marker));
  });
}

export function isGpuMarkerUsable(
  marker: GpuMarker | null,
  appVersion: string,
  electronVersion: string,
  now = Date.now(),
): marker is GpuMarker {
  return (
    marker !== null &&
    marker.schema === 1 &&
    marker.appVersion === appVersion &&
    marker.electronVersion === electronVersion &&
    Number.isFinite(marker.updatedAt) &&
    now - marker.updatedAt <= GPU_MARKER_TTL_MS
  );
}

export function shouldFallbackStartup(marker: GpuMarker | null, now = Date.now()): boolean {
  return (
    marker !== null &&
    marker.mode === 'hardware' &&
    marker.startupPending === true &&
    typeof marker.startupAt === 'number' &&
    now - marker.startupAt <= GPU_STARTUP_PENDING_TTL_MS
  );
}

export function parseGpuProbeOutput(stdout: string): GpuProbeResult | null {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith('GPU_PROBE:'));
  if (!line) return null;

  try {
    const value = JSON.parse(line.slice('GPU_PROBE:'.length)) as Partial<GpuProbeResult>;
    if (typeof value.ok !== 'boolean' || typeof value.reason !== 'string') return null;

    return {
      ok: value.ok,
      reason: value.reason,
      gpuCompositing: typeof value.gpuCompositing === 'string' ? value.gpuCompositing : 'unknown',
      opengl: typeof value.opengl === 'string' ? value.opengl : 'unknown',
      webgl: typeof value.webgl === 'string' ? value.webgl : 'unknown',
      vendors: Array.isArray(value.vendors)
        ? value.vendors.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
        : [],
      virtualGpu: value.virtualGpu === true,
      ...(typeof value.gpuGone === 'string' ? { gpuGone: value.gpuGone } : {}),
      ...(typeof value.gpuInfoError === 'string' ? { gpuInfoError: value.gpuInfoError } : {}),
    };
  } catch {
    return null;
  }
}

export function buildRelaunchArgs(argv: readonly string[]): string[] {
  const args = argv
    .slice(1)
    .filter(
      (arg) =>
        arg !== '--gpu-probe' &&
        arg !== '--gpu-status' &&
        arg !== '--enable-gpu' &&
        arg !== '--force-gpu',
    );

  if (!args.includes('--disable-gpu')) args.push('--disable-gpu');
  return args;
}
