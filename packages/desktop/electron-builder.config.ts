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
    // Debian control 的 Description 首行；不设置时 electron-builder 会生成空的 synopsis。
    synopsis: 'czagent 桌面客户端',
    description: 'czagent 桌面端（electron-vite + React）',
  },
  deb: {
    // 这些库在纯净 Deepin 25 上通常已安装；显式声明后 apt install ./xxx.deb 可自动补齐。
    // 同时用 | 兼容 Debian 13 的 t64 包名，避免只面向 Deepin 时锁死包名。
    depends: [
      'libgtk-3-0 | libgtk-3-0t64',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6 | libxtst6t64',
      'xdg-utils',
      'libatspi2.0-0 | libatspi2.0-0t64',
      'libuuid1',
      'libsecret-1-0',
      'libgbm1',
      'libasound2 | libasound2t64',
      'libdrm2',
      'libxkbcommon0',
    ],
    priority: 'optional',
    packageCategory: 'utils',
  },
  // better-sqlite3 的 prebuilt 二进制与当前 Electron ABI 兼容（dev 模式长期验证），
  // 打包跳过源码 rebuild（免 Visual Studio 依赖）；node-pty/sharp 自带各平台 prebuilt。
  npmRebuild: false,
};

export default config;
