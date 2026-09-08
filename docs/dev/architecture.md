# 架构设计

> 对应 PLAN.md 决策 #1、#2、#25

## 1. Monorepo 结构

```
czagent/
├── pnpm-workspace.yaml
├── package.json                     # 根：脚本编排（dev/dev:ui/build/typecheck/test）
├── .npmrc                           # 国内源 + electron/native 镜像（见 packaging.md）
├── tsconfig.base.json
├── packages/
│   ├── core/                        # 纯 Node/TS agent 引擎（无 Electron 依赖，可独立测试）
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts            # 对外出口（Provider 契约、SessionManager、类型）
│   │   │   ├── provider.ts         # ★ Provider 契约（渲染层唯一依赖的接口）
│   │   │   ├── llm/                # 协议引擎
│   │   │   │   ├── transport.ts    # HTTP transport + SSE 解析
│   │   │   │   ├── events.ts       # LLMEvent 统一事件模型
│   │   │   │   ├── errors.ts       # 错误分类/重试/脱敏
│   │   │   │   ├── usage.ts        # usage 归一化与计费
│   │   │   │   ├── catalog.ts      # 内置模型目录（三家默认）
│   │   │   │   └── providers/      # deepseek / siliconflow / agnes / openai-compatible
│   │   │   ├── agent/              # 主循环、agent 定义、build/plan 提示词、plan 工具
│   │   │   ├── session/            # SessionManager、会话运行态、compaction、消息模型
│   │   │   ├── tools/              # 工具注册表 + 内置工具
│   │   │   ├── permission/         # 权限服务、cwd 边界、ask 流程
│   │   │   ├── storage/            # drizzle schema + better-sqlite3 client + migrations
│   │   │   ├── config/             # JSON 配置加载/校验/合并/热重载
│   │   │   ├── attachments/        # 解析器（txt/md/docx/xlsx/pptx/pdf/image）
│   │   │   ├── scripts/            # (P2) 编排脚本执行器
│   │   │   ├── skills/             # (P2) skill 发现与加载
│   │   │   └── mcp/                # (P2) MCP 客户端桥
│   │   └── test/                   # vitest 单测/集成测试
│   └── desktop/
│       ├── package.json
│       ├── electron.vite.config.ts
│       ├── src/main/               # 窗口、IPC handlers、pty 会话、加载 core
│       ├── src/preload/            # contextBridge 暴露类型安全 API（real Provider 实现）
│       └── src/renderer/           # React UI（mock/real Provider 二选一注入）
└── docs/                           # 本方案文档
```

## 2. 进程模型

```
┌────────── Main (Node) ──────────┐   ┌────────── Renderer (Chromium) ──────────┐
│ SessionManager                  │   │ React 应用                              │
│  ├─ SessionRuntime×N (agent loop)│◄─►│  Provider 契约实例（real 或 mock）       │
│  ├─ ToolRegistry / Permission    │   │  zustand stores（sessions/chat/settings）│
│  ├─ sqlite (better-sqlite3)      │   │  virtual list + markdown worker         │
│  ├─ PtyPool（node-pty）          │   └────────────────────────────────────────┘
│  └─ LLM protocol engine         │
└────────────┬────────────────────┘
             │ contextBridge (preload) —— 仅白名单 API，无 Node 泄漏
```

- **core 跑在主进程**：全部副作用（文件、终端、网络、数据库）在主进程完成，渲染层无 Node 权限。
- **preload 是唯一桥**：`contextBridge.exposeInMainWorld('czagent', api)`，`api` 类型即 Provider 契约。
- **多会话并发**：每个会话一个 `SessionRuntime` 异步任务，共享主进程事件循环（LLM 是异步 HTTP、bash 走子进程，不阻塞）。并发上限默认 4，超出排队。
- **安全**：渲染层 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

## 3. Provider 契约（★ 决策 25 的核心）

渲染层**只依赖这一个接口**，不感知 Electron / core 内部实现。

```ts
// packages/core/src/provider.ts（示意）
export interface AgentProvider {
  // 会话
  listSessions(): Promise<SessionMeta[]>;
  createSession(input: CreateSessionInput): Promise<SessionMeta>;
  updateSession(id: string, patch: SessionPatch): Promise<SessionMeta>;
  deleteSession(id: string): Promise<void>;
  // 消息
  getMessages(sessionId: string, opts: PageQuery): Promise<MessagePage>;  // 反向分页
  sendMessage(sessionId: string, input: SendMessageInput): Promise<Message>;
  stopSession(sessionId: string): Promise<void>;
  // 流式事件订阅
  onEvent(cb: (ev: SessionEvent) => void): () => void;   // 按 sessionID 分流
  // 配置
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  // 附件
  uploadAttachment(sessionId: string, file: FileRef): Promise<Attachment>;
  // 权限确认（真实实现由主进程弹窗；mock 直接放行）
  resolvePermission(req: PermissionRequest): Promise<PermissionDecision>;
}
```

- **real 实现**：desktop `src/preload/index.ts` 内 `ipcRenderer.invoke` 封装；事件用 `webContents.send('session:event', ev)` → preload 转发给 `onEvent` 订阅。
- **mock 实现**：`core` 或 `desktop/renderer/mock/` 内纯浏览器实现，假会话数据 + 脚本化模拟流式（见 ui-design.md §8），供 `pnpm dev:ui` 用 Vite 直跑。
- **切换方式**：渲染层按 `import.meta.env.MODE` / 编译开关注入不同实现，接口零改动。

## 4. IPC 协议与事件流

### 4.1 请求-响应（invoke）

| 通道 | 方向 | 载荷 |
|---|---|---|
| `session:list` | R→M | — |
| `session:create` | R→M | `CreateSessionInput` |
| `session:patch` | R→M | `SessionPatch` |
| `session:delete` | R→M | `id` |
| `messages:page` | R→M | `{ sessionId, beforeId?, limit }` |
| `messages:send` | R→M | `SendMessageInput` |
| `session:stop` | R→M | `id` |
| `settings:get` / `settings:update` | R→M | — / `SettingsPatch` |
| `attachment:upload` | R→M | `{ sessionId, bytes, name, type, size }` |
| `permission:resolve` | R→M | `PermissionRequest` → `PermissionDecision` |

### 4.2 流式事件（main → renderer，`session:event`）

所有事件带 `sessionId`，渲染层按会话分发到对应 store，实现"多会话同时执行、切换不打断"。

```
SessionEvent = 
  | { sessionId, type: 'message.part.delta', messageId, partId, part }   // 流式增量
  | { sessionId, type: 'message.part.done',  messageId, partId, part }   // part 完成
  | { sessionId, type: 'message.complete',   messageId, message }        // 消息完成
  | { sessionId, type: 'session.status',     status, runId }             // running/queued/idle
  | { sessionId, type: 'session.usage',      usage }                     // token/cost 更新（逐轮 LLM 请求后推送的会话累计值）
  | { sessionId, type: 'session.context',    usage }                     // 本次请求用量（≈当前上下文规模），占用条逐轮实时刷新
  | { sessionId, type: 'permission.request', request, resolve }          // 权限弹窗
  | { sessionId, type: 'session.updated',    meta }                      // 标题/状态变更
```

> 借鉴 opencode：主循环把 LLM 输出归一化为统一事件流，增量持久化到 sqlite；IPC 层把它推给渲染层，渲染层只消费 `SessionEvent`，二者共享同一套 part 结构。

## 5. 依赖方向与测试策略

- **依赖单向**：`renderer → provider 契约 ← preload → core ← llm/protocol`；core 不依赖任何 UI / Electron 类型。
- **core 可独立测试**：vitest 直接构造 `SessionManager`，注入内存 DB / mock LLM 传输，跑 agent loop 集成测试。
- **mock 可跑浏览器**：UI 交互、滚动、流式渲染在浏览器验证，不启动 Electron。
- **E2E（可选，P3）**：Playwright + Electron。

## 6. 关键设计原则（源自 opencode 源码分析）

1. **统一事件流收敛**：无论哪家厂商、哪个能力（chat/embedding/rerank/图像/视频），协议层最终产出统一的 `LLMEvent` 流，下游无感知。opencode 双运行时（AI SDK / 原生）最终都收敛到 `@opencode-ai/llm` 的 `LLMEvent`。
2. **增量持久化**：流式过程中每个 part 增量落库（text/reasoning/tool-call/tool-result），窗口刷新即得最新状态，崩溃可恢复。
3. **四轴协议分解**（参考 `packages/llm/src/route/`）：Protocol（说什么 API） / Endpoint（URL） / Auth（鉴权） / Framing+Transport（SSE/HTTP），新厂商 = 组合 profile，协议 bug 一次修复全局生效。
4. **Provider 抽象缝**：UI 与 core 解耦，保证"先跑界面交互"的迭代节奏。
