# 040 · 逐轮 system-reminder 注入 + 工具描述重写 + bash 超时参数化 + skill 校验

日期：2026-09-10
前置：结合 `docs/ref/opencode-prompt-cn/`（提示词参考）与 `docs/ref/opencode-src/`（opencode 源码）对照分析现有提示词处理方式，用户拍板实施 P0 四项。触发问题：Plan 模式的只读约束只存在于 agent systemPrompt，切到 Build 后计划/约束随长上下文稀释（plan-exit 的切换信号仅一条 tool result、计划正文会被 prune 裁剪）；`<available_skills>` 指引行中 `{name}` 占位符从未被替换（原样发给模型）；工具描述多为一句式，缺少用法/何时不用/并行指引；bash 固定 60s 超时对下载/安装类命令不合理且超时即抛错丢弃已捕获输出。

## 现状结论（调研）

- **Plan 约束保障是双层的**：工具白名单 + 权限 deny 硬兜底（无安全漏洞），但行为层面缺锚定——切换意图、计划内容、模式约束全在历史里，随长上下文稀释或被 `pruneHistory`（40k token 后工具输出替换占位符）裁剪。
- **opencode 的做法**：逐轮 `<system-reminder>` 注入（plan-reminder 每轮 / build-switch 切换轮 / max-steps 临近）；bash 超时为每调用可选 `timeout` 参数（默认 120s、仅正数校验不设上限、默认值动态渲染进工具描述），超时不抛错而是保留部分输出并追加 `<shell_metadata>` 提示"用更大的 timeout 重试"。
- **czagent 差异点**：bash 用 pty 且无流式输出 UI（不吐中间输出），用户在长命令期间看不到进度——这是讨论"是否设硬上限"的关键；最终用户拍板不设上限（对齐 opencode，靠会话中止兜底）。

## 决策（用户拍板）

- P0 范围四项：① system-reminder 逐轮注入（**含** todo 进度快照）；② `{name}` bug + skill 工具校验；③ 工具描述中文重写（13 项，原创文案贴 czagent 行为，不照搬 opencode）；④ bash 超时参数化。
- reminder 追加位置：**消息数组最后一条**（user 或 tool，与 TODO_HINT 尾注先例一致，显著性最强）。
- skill 未找到：throw → **返回引导文本**（错误路径计入 doom-loop 且不利于模型纠正）。
- bash timeout **不设上限**（仅正整数校验）；**不加** workdir/description 参数（czagent 的权限边界是 session cwd + 权限矩阵，workdir 会引入目录逃逸问题且 `cd X && cmd` 已可见地等价；description 的权限确认展示价值可由 UI 显示原始命令替代）。
- 提示词全中文，保留英文术语。

## 变更

- **`core/src/reminders.ts`（新增）**：`buildTurnReminder(ctx)` 纯函数——四类提醒（Plan 只读 / plan→build 切换+计划锚定截 4000 字符 / todo 快照截 1500 字符 / max-steps 剩余 ≤3 轮预警）；`appendTurnReminder(messages, reminder)` 追加到最后一条消息（空提醒/空数组原样返回，不修改入参）。
- **`core/src/node/session-manager.ts`**：`buildRequestMessages()` 增加第 5 参 `reminder`（请求时拼装、不落库；压缩重试的 3 处调用点统一传入；`estimateContext`/`runSubAgent`/脚本 child 不传不受影响）；runLoop 增加 `prevAgentId` 跨轮追踪（请求组装后更新）与 `lastPlans` 内存 Map（会话删除时清理）；`buildEnvBlock` 指引行消除字面 `{name}`。
- **`core/src/tools/types.ts`**：`ToolContext` 增加可选 `savePlan`。
- **`core/src/tools/plan.ts`**：提交计划时 `ctx.savePlan?.(plan)` 缓存；plan/plan-exit 描述润色（流程与确认语义）。
- **`core/src/tools/skill.ts`**：未找到技能返回引导文本（可用清单；无技能时明确"不要再调用"）；精确→大小写不敏感匹配；仅缺 name 参数保留 throw；描述重写。
- **工具描述重写**：`read`/`write`/`edit`/`glob`/`grep`/`webfetch`/`websearch`/`task`/`question`——每条含"用法 + 何时不用/注意"，贴合实现细节（read 2MB 上限与返回头行数、edit 先 read 再 edit、webfetch 2000 字符落盘阈值、task 子代理自包含 prompt 与并行派遣、grep 60 条上限等）。
- **`core/src/tools/bash.ts`（P0-4）**：schema 增加 `timeout`（正整数 ms，不设上限，默认 `bashTimeoutMs=120_000`，负数/0/非整数报错）；超时/用户中止**不抛错**——kill 后返回已捕获输出（照常 30k 截断）+ `<shell_metadata>` 中文提示，`exitCode` 124（GNU timeout 惯例）/130（SIGINT 惯例）；`BASH_DESCRIPTION` 平台双分支重写（无需 cd、超时默认值、并行/&& 指引、非交互警告、专用工具优先）；保留 `setBashTimeoutMs` 测试辅助。
- **文档**：`docs/dev/agent-loop.md` §3 重写为实际实现并新增 §3.1 逐轮 reminder 机制表；`docs/dev/tools-and-permissions.md` §4 bash 更新（独立 pty 实况、超时参数化语义）；`docs/dev/skills-and-mcp.md` §1.3 更新 skill 匹配/引导文本/占位符修复。

## 验证

- `pnpm -r typecheck` ✅（core + desktop）。
- `pnpm -r test` ✅ core 64/64：新增 `test/reminders.test.ts` 13 例（四类触发条件、追加位置 user/tool、截断、一次性切换、入参不可变）+ `test/bash-timeout.test.ts` 4 例（参数校验、正常路径、超时 124+部分输出+重试提示、中止 130）；`test/script-ctx.test.ts` skill 用例更新为新语义（引导文本 + 大小写兜底）。
- **Electron 冒烟 ✅（041 前完成）**：Plan 提交计划 → plan-exit 确认切换后 Build 首轮按计划锚定执行；todo 快照与 skill 加载/引导文本正常；耗时命令大 timeout 正常完成、小 timeout 收到 124 + 重试提示。用户确认测试未发现问题。
