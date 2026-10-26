import { describe, expect, it } from 'vitest';
import {
  GPU_MARKER_TTL_MS,
  GPU_STARTUP_PENDING_TTL_MS,
  buildRelaunchArgs,
  isGpuCompositingEnabled,
  isGpuMarkerUsable,
  isVirtualGpuVendor,
  isVirtualMachineDmi,
  parseGpuProbeOutput,
  shouldFallbackStartup,
  type GpuMarker,
} from '../src/main/gpu-mode-core';

const now = 1_800_000_000_000;

function marker(patch: Partial<GpuMarker> = {}): GpuMarker {
  return {
    schema: 1,
    appVersion: '0.1.1',
    electronVersion: '44.0.0',
    mode: 'hardware',
    reason: 'probe:gpu-compositing=enabled',
    updatedAt: now,
    ...patch,
  };
}

describe('GPU marker', () => {
  it('accepts a fresh marker for the same app and Electron version', () => {
    expect(isGpuMarkerUsable(marker(), '0.1.1', '44.0.0', now)).toBe(true);
  });

  it('rejects version changes and expired markers', () => {
    expect(isGpuMarkerUsable(marker(), '0.1.2', '44.0.0', now)).toBe(false);
    expect(isGpuMarkerUsable(marker(), '0.1.1', '45.0.0', now)).toBe(false);
    expect(
      isGpuMarkerUsable(marker({ updatedAt: now - GPU_MARKER_TTL_MS - 1 }), '0.1.1', '44.0.0', now),
    ).toBe(false);
  });

  it('falls back only when a hardware startup is recently pending', () => {
    expect(
      shouldFallbackStartup(
        marker({ startupPending: true, startupAt: now - 1_000 }),
        now,
      ),
    ).toBe(true);
    expect(
      shouldFallbackStartup(
        marker({ startupPending: true, startupAt: now - GPU_STARTUP_PENDING_TTL_MS - 1 }),
        now,
      ),
    ).toBe(false);
    expect(shouldFallbackStartup(marker({ startupPending: false }), now)).toBe(false);
  });
});

describe('GPU probe output', () => {
  it('parses the probe line and ignores other stdout', () => {
    const result = parseGpuProbeOutput(
      [
        'some chromium noise',
        'GPU_PROBE:{"ok":true,"reason":"probe:gpu-compositing=enabled","gpuCompositing":"enabled","opengl":"enabled_on","webgl":"enabled","vendors":[4318,32902],"virtualGpu":false}',
      ].join('\n'),
    );

    expect(result).toEqual({
      ok: true,
      reason: 'probe:gpu-compositing=enabled',
      gpuCompositing: 'enabled',
      opengl: 'enabled_on',
      webgl: 'enabled',
      vendors: [4318, 32902],
      virtualGpu: false,
    });
  });

  it('returns null for missing or invalid output', () => {
    expect(parseGpuProbeOutput('')).toBeNull();
    expect(parseGpuProbeOutput('GPU_PROBE:not-json')).toBeNull();
    expect(parseGpuProbeOutput('GPU_PROBE:{"ok":true}')).toBeNull();
  });
});

describe('GPU decisions', () => {
  it('recognizes common virtual GPU vendors', () => {
    expect(isVirtualGpuVendor(0x15ad)).toBe(true);
    expect(isVirtualGpuVendor(0x80ee)).toBe(true);
    expect(isVirtualGpuVendor(0x1af4)).toBe(true);
    expect(isVirtualGpuVendor(0x10de)).toBe(false);
    expect(isVirtualGpuVendor(0x8086)).toBe(false);
  });

  it('treats all enabled compositing variants as hardware-capable', () => {
    expect(isGpuCompositingEnabled('enabled')).toBe(true);
    expect(isGpuCompositingEnabled('enabled_on')).toBe(true);
    expect(isGpuCompositingEnabled('enabled_force_on')).toBe(true);
    expect(isGpuCompositingEnabled('disabled_software')).toBe(false);
    expect(isGpuCompositingEnabled('unknown')).toBe(false);
  });

  it('detects VM DMI strings without treating generic Microsoft DMI as a VM', () => {
    expect(isVirtualMachineDmi(['VMware Virtual Platform'])).toBe(true);
    expect(isVirtualMachineDmi(['Standard PC (Q35 + ICH9, 2009)'])).toBe(true);
    expect(isVirtualMachineDmi(['VirtualBox'])).toBe(true);
    expect(isVirtualMachineDmi(['ASUS PRIME B650-PLUS'])).toBe(false);
    expect(isVirtualMachineDmi(['Microsoft Corporation'])).toBe(false);
  });

  it('builds relaunch args without the probe flag or duplicate disable-gpu', () => {
    expect(buildRelaunchArgs(['/opt/czagent/czagent', '--gpu-probe'])).toEqual([
      '--disable-gpu',
    ]);
    expect(buildRelaunchArgs(['/opt/czagent/czagent', '--disable-gpu'])).toEqual([
      '--disable-gpu',
    ]);
    expect(buildRelaunchArgs(['/opt/czagent/czagent', '--gpu-status', '--foo'])).toEqual([
      '--foo',
      '--disable-gpu',
    ]);
    expect(
      buildRelaunchArgs(['/opt/czagent/czagent', '--force-gpu', '--enable-gpu']),
    ).toEqual(['--disable-gpu']);
  });
});
