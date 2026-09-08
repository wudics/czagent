import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.czagent.app',
  productName: 'czagent',
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: ['out/**/*', 'package.json'],
  // 原生模块与需 spawn 的二进制必须在 asar 外：
  // - better-sqlite3 / sharp：.node 原生绑定
  // - @lydell/node-pty*：bash 工具的 PTY 原生绑定（各平台 prebuilt 由 optionalDependencies 提供）
  // - @esbuild/**：脚本子进程 bundle 用的 esbuild 平台二进制（spawn 不能从 asar 内执行）
  asarUnpack: [
    '**/node_modules/better-sqlite3/**',
    '**/node_modules/sharp/**',
    '**/node_modules/@img/sharp-*/**',
    '**/node_modules/@lydell/node-pty*/**',
    '**/node_modules/@esbuild/**',
  ],
  extraResources: [
    // 内置技能：打包态 main 用 process.resourcesPath/skills 读取（见 src/main/index.ts）
    { from: 'resources/skills', to: 'skills' },
    // 应用图标：打包态 BrowserWindow 的 icon 选项用 process.resourcesPath/icon.png 读取（Linux 任务栏窗口图标）
    { from: 'build/icon.png', to: 'icon.png' },
  ],
  win: {
    target: ['nsis', 'portable'],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  mac: {
    target: ['dmg'],
    category: 'public.app-category.developer-tools',
    // 无 Apple 开发者证书：显式跳过签名（CI 上避免误触签名流程）
    identity: null,
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    executableName: 'czagent',
    artifactName: '${productName}-${version}_${arch}.${ext}',
  },
  // better-sqlite3 的 prebuilt 二进制与当前 Electron ABI 兼容（dev 模式长期验证），
  // 打包跳过源码 rebuild（免 Visual Studio 依赖）；node-pty/sharp 自带各平台 prebuilt。
  npmRebuild: false,
};

export default config;
