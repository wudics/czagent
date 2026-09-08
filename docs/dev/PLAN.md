# czagent 桌面智能体 · 总体方案

> 版本：v1.0（已与需求方逐项确认 25 项决策后定稿）
> 状态：**方案已定稿，尚未开始编码**

## 1. 项目定位

一款跨平台（Windows / macOS / Linux）桌面智能体应用，核心是**自主决策的 agent** 与**脚本编排**两种执行模式，内置多平台大模型接入（DeepSeek / SiliconFlow / Agnes / 任意 OpenAI 兼容厂商），支持技能（Skill）、MCP、文件工具链、多会话并行、长上下文自动压缩。

## 2. 参考材料

| 材料 | 路径 | 用途 |
|---|---|---|
| opencode 源码 | `docs/ref/opencode-1.18.19-src/` | agent loop、协议层、权限、压缩、工具系统的设计参考 |
| opencode 中文提示词 | `docs/ref/opencode-prompt-cn/` | build/plan、工具描述、agent 提示词的文案参考 |
| 大模型 API 文档 | `docs/ref/大模型api接口文档/` | DeepSeek / SiliconFlow / Agnes 三家接口实现的权威依据 |

## 3. 技术路线

**Electron + React + Node + shadcn/ui + 自研 agent loop**，pnpm monorepo 组织，纯 TypeScript（strict）。

### 3.1 核心选型表

| 维度 | 选型 | 理由 |
|---|---|---|
| 包管理 | pnpm workspace | 多包复用、依赖可控 |
| 框架壳 | electron-vite + electron-builder | 官方成熟链路，三平台打包 |
| UI | React 19 + Tailwind v4 + shadcn/ui | 组件生态成熟 |
| 状态管理 | zustand | 轻量，适合多会话 store |
| 虚拟滚动 | @tanstack/react-virtual | 动态高度测量，支持反向分页 |
| Markdown 渲染 | react-markdown + remark-gfm + Web Worker | 流式渲染不卡主线程 |
| 数据库 | better-sqlite3 + drizzle-orm | opencode 同款，同步 API 稳定 |
| 终端 | @lydell/node-pty | 交互式命令、Ctrl+C、真实 shell |
| 协议层 | 自研轻量 OpenAI 兼容引擎 | 全能力可控，三家差异 profile 化 |
| 测试 | vitest | 与 Vite 同栈 |
| i18n | i18next / react-i18next | 中文优先，预留英文 |

## 4. 已确认决策清单（25 项共识）

| # | 主题 | 决策结论 |
|---|---|---|
| 1 | 项目结构 | pnpm monorepo（`packages/core` + `packages/desktop`） |
| 2 | 渲染↔核心通信 | Electron IPC（contextBridge），流式事件按 sessionID 多路复用 |
| 3 | 存储 | better-sqlite3 + drizzle-orm |
| 4 | 协议层 | 自研轻量 OpenAI 兼容引擎（不依赖 Vercel AI SDK / openai-node） |
| 5 | 模型目录 | 内置三家默认目录 + 用户覆盖，本地优先、离线可用 |
| 6 | 自主选模型 | 工具参数级选型；子代理路由为 P2 扩展 |
| 7 | Python 角色 | 附件解析用 Node 库；python 仅作脚本编排可选执行器（不捆绑运行时） |
| 8 | 脚本编排 | JS/TS 为主（Node 进程内执行），python 执行器 P2 |
| 9 | 会话模式 | 统一消息流，会话可选"对话 / 脚本编排"模式 |
| 10 | 配置存储 | JSON 配置文件（全局 + 工作区级，opencode 风格），内置 build/plan 默认值 |
| 11 | 上下文压缩 | opencode 式摘要压缩（溢出检测 + 保留窗口 + 摘要 checkpoint + 工具输出截断 + overflow 重跑） |
| 12 | 附件策略 | 混合：小文件解析内联 / 大文件 temp 引用 / 图片走 vision |
| 13 | 工作目录 | 每会话独立 cwd；cwd 内读写、外只读/询问；bash 按路径检查 |
| 14 | 对话滚动 | @tanstack/react-virtual + 反向分页 + 距底阈值自动滚动 |
| 15 | 思考模式 | 会话级三档（关闭/思考/深度思考）映射各家 thinking 参数，reasoning 内联样式渲染 |
| 16 | bash 工具 | node-pty（Win→powershell，Linux/mac→bash/zsh） |
| 17 | websearch | 自研抓取国内搜索引擎（360/搜狗/国内Bing/百度），高匹配走 webfetch，翻页≤3 |
| 18 | build/plan | 用户切换 + agent 通过 plan 工具自主进出 |
| 19 | MCP | 官方 @modelcontextprotocol/sdk，stdio + HTTP/SSE |
| 20 | Skill | opencode 兼容 markdown skill（SKILL.md + 全局/工作区双目录发现） |
| 21 | 多会话并发 | 独立 loop + 可配并发上限（默认 4）+ 事件分流 + 切换不打断 |
| 22 | Markdown | react-markdown + Worker 渲染 + GFM/代码高亮 |
| 23 | 语言 | 中文优先 + i18next 预留英文 |
| 24 | 分期 | walking skeleton 增量交付，每轮可运行可体验 |
| 25 | UI/Core 解耦 | Provider 接口抽象 + Mock 实现（浏览器直跑 UI） |

## 5. 总体架构

```
┌─────────────────────────── Electron Desktop ───────────────────────────┐
│  Renderer (React)          │  Preload (contextBridge)  │  Main (Node)  │
│  会话列表 / 对话区 / 设置     │◄─── typed IPC API ────►│  SessionManager│
│  zustand + virtual + markdown│   event (sessionID)     │  AgentLoop×N  │
│  ▲                          │                          │  工具/权限     │
│  │ Provider 契约            │                          │  sqlite        │
│  └─(mock 实现可浏览器直跑)    │                          │  protocol引擎  │
└─────────────────────────────┴──────────────────────────┴───────────────┘
                              ▲
                              │
        ┌─────────────────────┴────────────┐
        │  packages/core（纯 Node，可独立测试） │
        │  llm / agent / session / tools /   │
        │  permission / storage / config     │
        └────────────────────────────────────┘
```

## 6. 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](./architecture.md) | monorepo 结构、进程模型、Provider 抽象缝、IPC 协议、LLMEvent 事件模型 |
| [data-model.md](./data-model.md) | SQLite schema、消息 parts 结构、会话状态机、token 统计 |
| [agent-loop.md](./agent-loop.md) | 主循环、终止条件、max steps、system prompt、上下文压缩、重试 |
| [llm-engine.md](./llm-engine.md) | 协议引擎、三家 profile、SSE 状态机、模型目录、能力 taxonomy、自主选模型 |
| [tools-and-permissions.md](./tools-and-permissions.md) | 工具注册表、内置工具清单、权限模型、bash、websearch |
| [ui-design.md](./ui-design.md) | 布局、虚拟滚动、流式渲染、思考模式样式、设置页 |
| [attachments.md](./attachments.md) | 附件解析、混合策略、temp 管理 |
| [script-orchestration.md](./script-orchestration.md) | 脚本编排 DSL、执行器（P2） |
| [skills-and-mcp.md](./skills-and-mcp.md) | Skill 格式与发现、MCP 客户端（P2） |
| [packaging.md](./packaging.md) | 打包、跨平台、国内源配置 |
| [risks.md](./risks.md) | 风险与对策 |

## 7. 迭代计划（walking skeleton）

每轮结束都保证可直接运行体验，用户上手操作并反馈后再进入下一轮。

| 迭代 | 交付物 | 体验方式 | 验收要点 |
|---|---|---|---|
| **I0 骨架** | monorepo + electron-vite + React/Tailwind/shadcn + IPC ping + 国内源 | `pnpm dev` 开窗口 | 三平台能起窗口 |
| **I1 界面交互** | Provider 契约 + Mock；三栏布局；会话 CRUD；虚拟滚动+反向分页；自动滚动/一键到底；reasoning 内联样式；工具卡片；思考模式三档；模型下拉；附件占位；模拟流式 | `pnpm dev:ui` 浏览器直跑 | 交互完整可玩，mock 流式流畅 |
| **I2 设置页** | 三家 provider / 模型目录 / agent(build/plan) / 权限规则 可编辑表单（mock→JSON） | 浏览器 | 配置可保存回显 |
| **I3 真实对话** | sqlite 持久化 + 协议引擎 chat 能力 + 最小 agent loop + token 统计 | `pnpm dev` Electron | 三家真实对话流式跑通 |
| **I4 只读工具** | 工具注册表 + 权限弹窗 + read/grep/glob/webfetch/bash | Electron | agent 能读文件/命令 |
| **I5 写工具** | write/edit/patch + cwd 内外权限完整化 | Electron | agent 能真实改代码 |
| **I6 增强** | 附件解析、上下文压缩、多会话并发、doom-loop、plan 模式 | Electron | 长会话可用 |
| **P2+** | 脚本编排 → websearch → skill → MCP → 多模态（每个增量可操作） | 逐步 | 按序补齐 |

## 8. 非目标（本期明确不做）

- 云端同步 / 团队协作 / 云端部署
- 自动更新（P3 考虑 electron-updater）
- 可视化编排画布（仅非可视化脚本编排）
- 内嵌浏览器 MCP / 远程控制
