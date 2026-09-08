# 脚本编排（P2，已随 I7→I14.1→I18 落地；本节为准）

> 对应 PLAN.md 决策 #8、#9。目标：类 Dify 的**非可视化**编排——用户编写脚本逻辑、可调用 agent，执行过程实时流入对话流。
> 实现演变：vm 沙箱（I7）→ 目录入口（I14）→ **node 子进程 + esbuild bundle + stdio JSON-RPC 桥（I14.1，现行）**；Python 执行器已搁置。用户视角文档：`docs/tut/脚本编写指南.md`。

## 1. 会话模式模型（决策 9）

- 会话可选 `chat` / `script` 两种模式。
- `script` 模式（I14.1 起）：移除输入框/附件，来源是工作目录入口文件（`czagent.ts` → `czagent.js` → `.czagent/run.ts` → `.czagent/run.js`），点 ▶ 运行；运行过程统一流入消息流。
- **统一消息流**：无论 agent loop 还是脚本执行，都产生同一种结构化消息/事件（`message.part.*`），渲染层统一渲染。

## 2. 脚本 DSL

脚本用 TypeScript/JavaScript 编写，esbuild bundle 后在 **node 子进程**执行：

```ts
// 导出默认 async 函数即编排入口
export default async function main(ctx: ScriptContext) {
  const files = await ctx.tools.glob({ pattern: 'src/**/*.ts' });

  // 并行步骤
  const [stats, summary] = await Promise.all([
    ctx.tools.bash({ command: 'git log --oneline -5' }),
    ctx.agent.run('总结这些提交的变更意图', { model: 'deepseek-v4-pro' }),
  ]);

  // 条件分支 + 循环
  if (files.length > 10) {
    await ctx.tools.write({ file: 'report.md', content: buildReport(files, summary) });
  }
  return { files: files.length, summary };
}
```

### 2.1 `ctx` 能力（I18 现行）

| 成员 | 说明 |
|---|---|
| `ctx.session` | 会话信息 `{ id, cwd, model, mode }`（cwd 为相对路径基准） |
| `ctx.settings` | 「通用」设置只读快照 `{ general }`（I18；不含 Provider/API Key；冻结不可改） |
| `ctx.tools` | 全部已注册工具 + MCP 工具的 Proxy 直接调用，**同样过权限系统**；支持 `(input, { timeoutMs })` 单次限时（I18） |
| `ctx.agent.run(prompt, opts)` | 委派隔离子 agent（内存 messages 不落库），实时流式；`opts`：`model` / `agent` / `tools`（白名单，可含 skill 与 mcp_* id）/ `maxSteps`（I18 覆盖 agent.steps）/ `mcpServers`（I18 显式 MCP 名单） |
| `ctx.log(...)` | 向对话流写日志/步骤节点 |
| `ctx.ask(...)` | 权限确认（同款 UI，不持久化 allowAlways） |
| `ctx.signal` | 中止信号（Stop 按钮/脚本超时） |

不可用：`question` / `task`（主会话专用）、`plan` / `plan-exit`（内部工具）。`ctx.tools` 不受工具矩阵"加载"开关限制，但权限列生效。

### 2.2 脚本特性

- 顺序 / `Promise.all` 并行 / `for` 循环 / `if` 条件——**标准 JS 语法**，无需专门 DSL。
- 结果作为 assistant 消息的 text part 返回（`✅ 脚本执行完成\n返回值：…`）；异常作为 error part 展示。
- 完整 Node 模块可用：npm 第三方包（含 ESM-only）经 bundle 打进产物；信任模型等同 `npm run`（无白名单、无沙箱）。

## 3. 执行器（I14.1 现行）

- **运行环境**：esbuild（platform=node / cjs / target node22）实时 bundle 入口 → 临时 `.cjs` → `spawn(process.execPath, ['--enable-source-maps', file], ELECTRON_RUN_AS_NODE=1)` 子进程。
- **通信**：stdio 换行分帧 JSON-RPC 桥。子→主：`tool / agent / ask / log / result / fail`；主→子：响应帧 + `abort`。非 JSON 行降级为日志。`ctx` 与返回值必须可 JSON 序列化。
- **生命周期**：AbortController 中止 → abort 帧 → 5s 宽限 → SIGKILL；脚本超时（`general.scriptTimeoutMinutes`，0=不限）同路径；并发占用 `maxConcurrency` 槽位；token/cost 记账（脚本内 agent 调用同样记账）。
- **Agent 委派实现**：`ctx.agent.run` → `runSubAgent`（隔离上下文轻量 loop；工具卡片 + `[agent]` 文本实时流入脚本消息；I18 起支持 reportProgress、MCP 工具执行、builtinSkillsDir）。

## 4. Python 执行器（已搁置）

决策 7 的可选部分，I14.1 子进程化后**搁置**（如需可按同样的 stdio 桥协议扩展，桥帧协议已与语言无关）。

## 5. 与对话模式的关系

- 脚本执行中可"停止"（Stop 按钮 → ctx.signal + abort 帧）。
- 脚本可以 `ctx.ask` 主动征询（权限弹窗同款 UI）。
- 运行完成写一条汇总 assistant 消息（返回值 JSON 化）。
- `ctx.tools.todo` 与主会话共享右侧任务清单面板（I18 起清单持久化到 sessions.todo 列，重启恢复）。

## 6. 安全边界

- 脚本运行在会话 cwd 权限体系内（文件/终端权限同 agent 工具，全量过权限系统）。
- 信任模型 = `npm run`（I14.1 拍板）：不做 fs/网络硬限制；`ctx.settings` 不暴露 Provider/API Key。
- 超时/资源：执行超时（可配）、单次工具调用限时（I18）；子进程内存上限、输出大小截断**未实现**（已知欠账）。
