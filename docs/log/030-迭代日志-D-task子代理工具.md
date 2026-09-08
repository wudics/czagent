# 030 · D — task 子代理工具（决策 6 P2：子代理路由）

日期：2026-09-06
前置：runSubAgent 已存在（脚本 `ctx.agent.run` 用）；本轮把它包成模型侧工具。拍板：禁止嵌套 + 实时流展示。

## 契约

`task { agent?: string='build', prompt: string }` → 子代理在**隔离上下文**自主多轮执行（只看 system+自包含 prompt+envBlock，不看主会话历史），最终文本作为 tool-result 返回。

## 实现

- `tools/task.ts`（新）：壳——prompt 必填；agentId 校验（未知 → 报错并列出可用 id，不发子请求）；`ctx.runAgent(prompt,{agentId})`；空结果回「（子代理没有产出内容）」。
- `tools/types.ts`：`ToolContext.runAgent?`。
- `session-manager.ts`：
  - runLoop 工具执行 ctx 注入 `runAgent` 闭包 → `this.runSubAgent(...)`，append/update 绑定当前 assistant 消息（`[agent]` 前缀文本流 + 子工具卡实时 emitPart + 落库）。
  - **防嵌套**：runSubAgent 工具解析额外排除 `task`、`question`（子代理不得再派生、问询保持主会话专用）。
  - 脚本 `ctx.tools` 排除 `task`（脚本派生用 `ctx.agent.run`）。
- 矩阵：`policy.ts` ALLOW_TOOLS 加 `task`（默认开+allow）、inventory `interact` 组；registry 注册+导出；Agent/权限矩阵自动出现「派遣子代理」行，可关。
- `settings-defaults.ts`：build systemPrompt 补一句（todo 用 statuses 推进、独立子任务用 task 派遣）。注意：仅影响新配置默认值；已持久化 config.json 里 build 的旧 prompt 不会被自动改写。
- i18n zh/en：`tools.labels.task`。

## 运行语义
- 在当前并发槽内执行（不占额外槽）；子代理内部工具照常过权限（可弹权限卡）；stop→signal abort→子代理提前返回；`maxSteps=agent.steps||16` 防失控；doom-loop 守卫在子循环内独立计数（沿用各自 runLoop/子循环状态）。

## 测试（core 209，新增 session-task 2）
- 主会话 `task {agent:'build'}`：子请求存在且 **tools 不含 task/question**；子请求只含 1 条 user 消息（隔离验证）；主消息含 `[agent]` 实时 part + tool-result 含 SUB_DONE。
- 未知 agent：tool-result 报错「未知 Agent「nope」」并列出可用；未发出子请求。
- tools.test/policy 回归更新。

## 验证
- typecheck ✅ · 测试 ✅（core 209 + desktop 11 = 220）· build ✅ · Electron 冒烟 ✅。

## 边界与后续
- 子代理结果目前不自动写入 todo 清单（模型自行转述）；如需"子代理完成后自动标状态"属于模型行为，非机制。
- P2 至此仅剩：chat 适配器化（已搁置）、python 执行器（已搁置）。下一站：**P3 打包分发**。
