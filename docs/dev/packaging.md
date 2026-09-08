# 打包、跨平台与国内源

> 对应 PLAN.md 决策 #1、#16、以及需求中的"适配 linux+windows+mac""国内源"要求。I16 起已实测落地。

## 1. 构建与打包链路

- 构建：`electron-vite`（main/preload/renderer 三端打包，TypeScript + Vite）。
- 打包：`electron-builder`，配置 `packages/desktop/electron-builder.config.ts`。

| 平台 | 目标格式 | 在哪构建 |
|---|---|---|
| Windows | NSIS 安装包 + portable 便携版 | 本机（Windows）/ CI |
| macOS | dmg（未签名，`identity: null`） | **只能在 macOS 上构建**（electron-builder 硬限制）→ CI macos runner |
| Linux | AppImage + deb | Linux 环境 / CI ubuntu runner |

命令（pnpm 需全局安装，直接用 `pnpm` 执行）：

```bash
pnpm install                             # 首次装依赖
pnpm --filter @czagent/desktop build        # electron-vite 三端产物
pnpm --filter @czagent/desktop package:dir  # 未打包目录（本机冒烟用）
pnpm --filter @czagent/desktop package      # 正式安装包（win 出 nsis+portable，linux 出 AppImage+deb）
```

- **CI**：`.github/workflows/release.yml` —— push `v*` tag（或手动 workflow_dispatch）时三平台矩阵构建并上传 artifacts；无签名 secrets。
- 图标：把 ≥512×512 的 `icon.png` 放到 `packages/desktop/build/`（electron-builder 自动转 ico/icns）；缺省时用 Electron 默认图标。

## 2. 原生模块

| 模块 | 用途 | 平台处理 |
|---|---|---|
| `better-sqlite3` | sqlite | v13 起 **N-API prebuilds**（`prebuilds/<平台>.node`，ABI 无关）——**无需 rebuild**，配置 `npmRebuild: false`（避免依赖 Visual Studio） |
| `@lydell/node-pty` | bash 工具 PTY | 各平台 optionalDependencies prebuilt（含 conpty/OpenConsole.exe） |
| `sharp` | 附件图像处理 | 自带平台 prebuilt（libvips 共享库在 `@img/sharp-libvips-<平台>`，需一并 asarUnpack，否则运行时 `ERR_DLOPEN_FAILED`） |
| `esbuild` | 脚本子进程 bundle | 平台二进制包 `@esbuild/<平台>`；**unix 二进制在 `bin/esbuild` 子目录，win32 在包根 `esbuild.exe`**——打包态解析见 `core/src/script/child.ts` 的 `resolvePackagedEsbuildBin`（漏 `bin/` 段会导致 `spawn ENOTDIR`） |

- `asarUnpack`：上述模块（含 `@img/*`、`@esbuild/*`）必须解包到 asar 外（`.node` 加载、libvips dlopen、esbuild/OpenConsole 需 spawn）。
- 打包后 smoke：`win-unpacked/czagent.exe` 启动无致命错误（sqlite 打开、无 ERR_）。

### 2.1 asar 与资源布局（打包态）

| 资源 | 开发态 | 打包态 |
|---|---|---|
| 内置技能 | `<repo>/resources/skills` | `extraResources` → `process.resourcesPath/skills`（`app.isPackaged` 切换，见 `src/main/index.ts`） |
| 主/preload/渲染产物 | `out/**` | `app.asar` 内 |
| esbuild 二进制 | node_modules | `app.asar.unpacked/node_modules/@esbuild/<平台>/bin/esbuild`（win32 为包根 `esbuild.exe`），经 `ESBUILD_BINARY_PATH` 注入 |

### 2.2 跨平台打包（Windows → Linux/macOS）

从 Windows 传源码到其他平台打包时，只需拷贝源码和配置，**不要拷 `node_modules/`**（目标平台 `pnpm install` 自动装对应平台的 native prebuilts）。

#### 必须拷贝

```
czagent/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml                     # 锁文件（必须保留，保证依赖版本一致）
├── .npmrc                             # 镜像配置（Linux/macOS 也可用 npmmirror 加速）
├── tsconfig.base.json
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/                       # 核心逻辑
│   └── desktop/
│       ├── package.json
│       ├── tsconfig.json
│       ├── electron-builder.config.ts
│       ├── electron.vite.config.ts
│       ├── build/icon.png             # 图标（≥512×512，没有则用默认图标）
│       ├── resources/skills/          # 内置技能（extraResources 源）
│       └── src/                       # Electron + React
```

#### 不要拷贝

| 目录/文件 | 原因 |
|---|---|
| `node_modules/` | 目标平台 `pnpm install` 重新装，native 模块自动取对应 prebuilts |
| `packages/desktop/release/` | 构建产物，重新打包生成 |
| `packages/desktop/out/` | electron-vite 构建产物 |
| `docs/` `.git/` `.github/` | 文档、版本控制、CI 配置，不进包 |

#### 一条命令打包（Windows 上执行）

```powershell
# 打包源码 → 传到 Linux → 解压 + 构建 + 打包
tar -czf czagent-src.tar.gz --exclude="node_modules" --exclude="release" --exclude="out" --exclude=".git" --exclude="docs" --exclude=".github" -C D:\Codings czagent
scp czagent-src.tar.gz user@linux:/path/to/
# Linux 上：
tar xzf czagent-src.tar.gz && cd czagent && pnpm install && pnpm --filter @czagent/desktop build && pnpm --filter @czagent/desktop package
```

产物在 `packages/desktop/release/`：`.AppImage`（免安装双击运行）和 `.deb`（`dpkg -i` 安装）。

macOS 同理，但必须在 macOS 机器上执行（electron-builder 限制），产物为 `.dmg`。

## 3. 国内源配置（关键）

### 3.1 `.npmrc`（仓库根）

```ini
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

### 3.2 pnpm 与 Electron/native 模块

pnpm 的 symlink 结构对 electron / 原生模块不友好，需在 `.npmrc`：

```ini
public-hoist-pattern[]=*electron*
public-hoist-pattern[]=*better-sqlite3*
public-hoist-pattern[]=*node-pty*
shamefully-hoist=true   # 必要时兜底（会牺牲严格隔离，视依赖情况取舍）
```

> 原因：Electron 二进制、原生 `.node` 在 `node_modules` 顶层的路径是硬编码约定，hoist 到顶层可避免启动/加载失败。

### 3.3 原生 prebuilt 国内下载

- better-sqlite3：prebuilt 走 GitHub Releases，国内可能失败。方案：`npm config set sqlite3_binary_host_mirror <镜像>`（或安装脚本在失败时提示手动下载 + 配置 `node_modules/.cache`）；CI/脚本内置镜像兜底。
- node-pty：`@lydell/node-pty-*` 平台包直接来自 npm（npmmirror 已镜像），一般无问题。

### 3.4 Python 源（P2，决策 7）

所有 python 相关安装脚本统一使用：

```bash
pip install <package> -i https://pypi.tuna.tsinghua.edu.cn/simple
```

写入 `docs/` 与脚本注释，作为约定。

### 3.5 Electron 二进制手动安装（Node < 20.19 兜底）

**现象**：Node < 20.19（如 20.15.1）下 `pnpm install` 时 electron 的 postinstall 报 `ERR_REQUIRE_ESM`——electron 44 的 `install.js` 用 `require('@electron/get')`，而 `@electron/get` 5.x 为 ESM-only，`require(esm)` 需 Node ≥ 20.19。electron-vite 启动时报 `Error: Electron uninstall`（包目录缺 `dist/` 与 `path.txt`）。

**兜底步骤**（绕过 install.js，直接从镜像取二进制）：

```bash
# 1. 下载对应平台 zip（以 linux-x64 为例；win 为 win32-x64，mac 为 darwin-arm64/x64）
curl -fsSL -o /tmp/electron.zip https://npmmirror.com/mirrors/electron/v44.0.0/electron-v44.0.0-linux-x64.zip

# 2. 定位包目录（pnpm store 内真实路径）
ELECTRON_DIR=$(ls -d node_modules/.pnpm/electron@*/node_modules/electron)

# 3. 解压到 dist/ 并写入 path.txt（linux/darwin 内容为 electron，win 为 electron.exe）
mkdir -p "$ELECTRON_DIR/dist" && unzip -oq /tmp/electron.zip -d "$ELECTRON_DIR/dist"
printf 'electron' > "$ELECTRON_DIR/path.txt"

# 4. 验证
"$ELECTRON_DIR/dist/electron" --version   # 输出 v44.0.0
```

**验证通过后** `pnpm dev` 即可正常启动。注意：删除 `node_modules` 重装后需重做此步骤（Node ≥ 20.19 环境无需兜底，postinstall 会自动完成）。

## 4. 应用数据目录（跨平台）

| 用途 | 路径 |
|---|---|
| 数据库 | `app.getPath('userData')/czagent.db` |
| 全局配置 | `app.getPath('userData')/config.json` |
| 全局 skills | `app.getPath('userData')/skills/` |
| 临时附件 | `app.getPath('temp')/czagent/attachments/<sessionId>/` |
| 日志 | `app.getPath('logs')/main.log`（electron-log） |

`shell-env` 适配：Windows/macOS GUI 应用获取用户 PATH（供 npx/python 子进程使用）需从 shell 环境注入（参考 opencode `shell-env.ts`）。

## 5. 窗口与体验

- 窗口状态持久化（electron-window-state），最小宽高限制。
- 深色/浅色/跟随系统主题；托盘（可选）。
- 单实例锁（`app.requestSingleInstanceLock`）。
- 崩溃恢复：主进程 `unhandledRejection` / 渲染进程崩溃重载；日志轮转。

## 6. 签名与自动更新

- **签名**：本轮无证书，Windows 安装包/便携版未签名（SmartScreen 会提示"仍要运行"），macOS dmg 未公证（Gatekeeper 需右键打开或系统设置放行）；`mac.identity: null` 已显式跳过。
- **自动更新**（后续）：electron-updater；NSIS 增量 + blockmap 已在产物中预留（`czagent Setup x.y.z.exe.blockmap`）。

## 7. 已验证记录（I16，Windows 本机）

- `package:dir` + `package` 全通过：`czagent Setup 0.1.0.exe`（NSIS）、`czagent 0.1.0.exe`（portable）。
- `win-unpacked/czagent.exe` 启动冒烟无致命错误；`app.asar.unpacked` 中 @esbuild/@lydell/sharp/better-sqlite3 齐全；`resources/skills/frontend-design` 就位。
- better-sqlite3 v13 为 N-API prebuild，`npmRebuild: false` 后 dev/打包同一二进制。
