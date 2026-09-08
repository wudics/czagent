import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePackagedEsbuildBin } from '../src/script/child.js';

/** 模拟打包态布局：resources/app.asar（文件）+ app.asar.unpacked/node_modules/@esbuild/<plat-arch>/[bin/]esbuild */
function makePackagedLayout(platform: string, arch: string, binaryAtRoot: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'czagent-esbuild-'));
  const binDir = join(root, 'resources', 'app.asar.unpacked', 'node_modules', '@esbuild', `${platform}-${arch}`, binaryAtRoot ? '' : 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, binaryAtRoot ? 'esbuild.exe' : 'esbuild'), '#!/bin/sh\n');
  // app.asar 必须是文件而非目录（复现 ENOTDIR 的关键）
  writeFileSync(join(root, 'resources', 'app.asar'), '');
  return root;
}

describe('resolvePackagedEsbuildBin', () => {
  it('unix 平台经 __filename 候选解析到 bin/esbuild', () => {
    const root = makePackagedLayout('linux', 'x64', false);
    try {
      const filename = join(root, 'resources', 'app.asar', 'out', 'main', 'index.js');
      const found = resolvePackagedEsbuildBin(filename, undefined, 'linux', 'x64');
      expect(found).toBe(join(root, 'resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unix 平台经 resourcesPath 兜底候选解析（ESM 态 filename 不可用）', () => {
    const root = makePackagedLayout('darwin', 'arm64', false);
    try {
      const resourcesPath = join(root, 'resources');
      const found = resolvePackagedEsbuildBin(undefined, resourcesPath, 'darwin', 'arm64');
      expect(found).toBe(join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('win32 平台二进制位于包根（无 bin/ 段）', () => {
    const root = makePackagedLayout('win32', 'x64', true);
    try {
      const resourcesPath = join(root, 'resources');
      const found = resolvePackagedEsbuildBin(undefined, resourcesPath, 'win32', 'x64');
      expect(found).toBe(join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('布局中无二进制时返回 null', () => {
    const root = mkdtempSync(join(tmpdir(), 'czagent-esbuild-'));
    try {
      const filename = join(root, 'resources', 'app.asar', 'out', 'main', 'index.js');
      expect(resolvePackagedEsbuildBin(filename, join(root, 'resources'), 'linux', 'x64')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dev 态（filename 不含 app.asar 且无 resourcesPath）返回 null', () => {
    expect(resolvePackagedEsbuildBin('/home/user/project/out/main/index.js', undefined, 'linux', 'x64')).toBeNull();
    expect(resolvePackagedEsbuildBin(undefined, undefined, 'linux', 'x64')).toBeNull();
  });
});
