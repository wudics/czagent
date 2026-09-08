# czagent

跨平台桌面 AI 智能体（Electron + React + Node + TypeScript），支持多 Provider 大模型（DeepSeek / SiliconFlow / Agnes 及任意 OpenAI 兼容服务）、工具调用与权限系统、技能（Skills）、MCP、脚本编排、多模态生成（图像/视频/语音）、任务清单与子代理派发。

## 功能总览

- **对话会话**：流式输出、思考模式、上下文压缩、附件理解、自动标题
- **工具系统**：21 个内置工具（文件读写/搜索/bash/网络/多媒体等）+ MCP 服务器接入；**逐工具矩阵**控制加载与权限
- **Agent**：内置 Build/Plan，自定义 Agent 可视化配置（工具、MCP、技能逐条开关）
- **脚本编排**：工作目录入口文件（`czagent.ts`）→ node 子进程执行，第三方包可用，`ctx.tools` / `ctx.agent.run` / `ctx.log` / `ctx.ask`
- **权限**：路径感知（工作目录内直写）、危险命令拦截、逐工具 allow/deny/ask
- **多模态**：文生图/图生图/文生视频/图生视频/TTS/ASR/embedding/rerank（Provider 适配层，未适配能力明确报错）

## 开发

环境要求：Node ≥ 20.15（本机 20.15.1 已验证；部分依赖官方 engines 声明要求更高版本，实际运行不受影响）；pnpm 需全局安装（`npm i -g pnpm`），所有命令直接用 `pnpm <cmd>` 执行（国内源已在 `.npmrc` 配好 npmmirror 与 Electron 镜像）。Node < 20.19 时 electron 的安装脚本会失败，兜底方案见 `docs/dev/packaging.md` §「Electron 二进制手动安装」。

```bash
pnpm install
pnpm dev          # 启动 Electron 开发模式
pnpm test         # 全量测试（core + desktop）
pnpm typecheck    # 类型检查
```

- `packages/core` —— 核心逻辑（会话循环、工具、权限、脚本运行器、适配层），不依赖 Electron
- `packages/desktop` —— Electron 壳（main / preload / renderer）

## 打包

产物输出到 `packages/desktop/release/`，全部命令在仓库根目录执行。

### Windows（本机已验证）

```bash
pnpm --filter @czagent/desktop build        # electron-vite 三端产物
pnpm --filter @czagent/desktop package:dir  # 可选：先出 win-unpacked 目录做冒烟
pnpm --filter @czagent/desktop package      # 正式包：NSIS 安装包 + portable 便携版
```

产物：

| 文件 | 说明 |
|---|---|
| `czagent Setup <版本>.exe` | NSIS 安装包（非一键、可选安装目录） |
| `czagent <版本>.exe` | portable 便携版（免安装单文件） |

### Linux（本机已验证）

```bash
pnpm install                               # 首次先装依赖
pnpm --filter @czagent/desktop build        # electron-vite 三端产物
pnpm --filter @czagent/desktop package:dir  # 可选：先出 linux-unpacked 目录做冒烟
pnpm --filter @czagent/desktop package      # 正式包：AppImage + deb
```

产物：

| 文件 | 说明 |
|---|---|
| `czagent-<版本>_x86_64.AppImage` | 免安装，`chmod +x` 后直接运行 |
| `czagent-<版本>_amd64.deb` | `sudo dpkg -i czagent-<版本>_amd64.deb` 安装 |

### 跨平台打包（Windows → Linux/macOS）

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
│       ├── build/icon.png             # 图标（≥512×512，没有则用 Electron 默认）
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

### CI 一键出三平台

`.github/workflows/release.yml` 已内置三平台矩阵（windows / macos / ubuntu）：

- **push `v*` tag**（如 `git tag v0.1.0 && git push origin v0.1.0`）或手动 workflow_dispatch 触发
- 完成后在 Actions artifacts 下载：NSIS + portable（win）、dmg（mac）、AppImage + deb（linux）

### 图标

把 ≥512×512 的 `icon.png` 放到 `packages/desktop/build/`，重新打包即自动生成 ico/icns；缺省时使用 Electron 默认图标。

### 打包要点（详见 `docs/dev/packaging.md`）

- better-sqlite3 v13 为 **N-API prebuilds**（ABI 无关），`npmRebuild: false`，无需 Visual Studio
- `asarUnpack`：better-sqlite3 / sharp + `@img/*`（libvips 共享库）/ node-pty（bash PTY）/ `@esbuild/*`（脚本子进程 bundle 二进制；unix 在 `bin/esbuild`，win32 在包根，见 `resolvePackagedEsbuildBin`）
- 内置技能经 `extraResources` 拷入，打包态 main 从 `process.resourcesPath/skills` 读取
- 当前**未做代码签名**：Windows 有 SmartScreen 提示（“仍要运行”），macOS 未公证需手动放行；更新所需的 `.blockmap` 已随产物输出

## 文档

- 迭代总览与队列：`docs/log/000-开发计划总览.md`（逐轮日志见 `docs/log/`）
- 脚本编写指南（用户向）：`docs/tut/脚本编写指南.md`
- 打包细节：`docs/dev/packaging.md`；脚本编排设计：`docs/dev/script-orchestration.md`；工具与权限设计：`docs/dev/tools-and-permissions.md`

## 许可

未定（私有项目）。
