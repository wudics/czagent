# 044 · plan 计划可见渲染与拒绝即停

日期：2026-09-10
前置：043 合入后用户使用 plan/plan-exit 过程中反馈的两个体验问题；设计参考 `docs/ref/opencode-src`（plan.ts / processor.ts / reminders.ts）。

## 问题（用户反馈）

1. **plan 工具提交的计划用户看不到**：计划全文在工具调用参数里（UI 默认折叠 JSON），工具输出只有「计划已提交（共 N 字）」，随后就弹 plan-exit 确认卡——用户从头到尾没见过计划内容，无法决策是否切换 Build。
2. **plan-exit 被拒绝后 agent loop 不停**：点「暂不执行」后工具返回普通文本，runLoop `continue`，模型收到结果继续跑（道歉/继续完善），不符合「拒绝 = 我说了算」的预期。

## opencode 参考实现（关键发现）

- **拒绝即停是全局机制**：plan_exit 用户选 No → 抛 `Question.RejectedError`（plan.ts:46）；`processor.ts:208-210` 捕获 RejectedError → `ctx.blocked = ctx.shouldBreak`；`processor.ts:785` `shouldBreak = experimental.continue_loop_on_deny !== true`（**默认停止**，「拒绝后继续」反而是实验开关）；`prompt.ts:1479` 收到 `"stop"` 即 break 整个 while 循环。
- **opencode 没有 plan 工具**：plan agent 用标准 write/edit 工具把计划写进 plan 文件（`Session.plan()`，权限白名单仅放行 plans/*.md），可见性来自标准文件工具渲染，plan-exit 弹窗引用文件路径——无需任何 plan 专用 UI。

## 方案（最小改动 + 通用机制）

计划可见不走 plan 专用渲染，复用既有的**富输出管线**（图片/文件已用此机制追加可见 part）；拒绝即停对齐 opencode 全局行为，配 `continueLoopOnDeny` 配置逃生门。

## 变更

**拒绝即停（对齐 opencode 默认）**

- **`core/src/tools/types.ts`**：新增 `UserRejectedError` 哨兵错误（工具内部 `ctx.ask` 被拒时抛出）。
- **`core/src/node/session-manager.ts`**：runLoop 声明 `denyStopReason`；两处拒绝入口统一置位——权限层 deny（原「用户拒绝了该操作」分支）与工具 catch 中 `instanceof UserRejectedError`；本轮工具结算完（tool-call/tool-result 配对完整落库）后 `break`，不再发起下一次请求；循环外仿 max-steps 收尾补一条用户可见提示（"……本轮到此停止。补充说明后直接发送即可继续。"），避免无声停止。
- **`core/src/tools/plan.ts`**：planExitTool 拒绝分支改抛 `UserRejectedError('用户暂不切换到执行模式，已留在 Plan 模式')`；确认分支不变（setAgent('build')）。
- **配置**：`general.continueLoopOnDeny`（默认 `false` = 拒绝即停；`true` 恢复旧的"错误反馈给模型继续跑"）。范围：仅主 runLoop；子代理循环内拒绝行为不变（结果作为报告返回主会话）。

**计划可见渲染（通用富输出）**

- **`core/src/tools/rich-output.ts`**：`RichToolOutput` 新增 `markdown?: { title?, text }`。
- **`core/src/provider.ts`**：text part 新增 `synthetic?: boolean`（仅展示、不进请求）。
- **`core/src/node/session-manager.ts`**：主循环与子代理两处富输出分支把 `output.markdown` 追加为 `{ type:'text', synthetic:true }` 可见 part；**三处过滤防双份入上下文**——`buildRequestMessages`（计划全文在 tool-call 参数里已有一份）、自动标题的 assistant 文本收集（防标题被计划全文污染）、`finalizeMessage` 用量估算兜底（计划非模型生成输出）。
- **`core/src/tools/plan.ts`**：planTool 返回 `richOutput({ text: '计划已提交…', markdown: { title:'实施计划', text: plan } })`——模型只收短文本，用户在聊天流直接看到完整渲染的计划。
- **plan-exit 确认卡内嵌预览**：`ToolContext` 新增 `lastPlan?: () => string|undefined`（SessionManager 注入读 `lastPlans` 缓存）；planExitTool 把计划全文放进 `ctx.ask` args；`desktop/.../PermissionCard.tsx` plan-exit 分支渲染可折叠「计划预览」（Markdown 组件，max-h-64 滚动），用户在决策点直接审阅。i18n 新增 `chat.planPreview`。

## 验证

- `packages/core` typecheck ✅；`pnpm test`：9 个测试文件 78 例全部通过 ✅（新增 `test/plan.test.ts` 5 例：富输出结构、空 plan 报错、拒绝抛 `UserRejectedError` 且不切 agent、确认切 build 并携带预览 args、无 lastPlan 时 args 为空）。
- `packages/desktop` typecheck ✅。
- 冒烟清单（待 UI 实测）：
  1. plan 模式提交计划 → 聊天流出现完整渲染的计划 markdown（工具卡下方），模型侧无重复上下文；
  2. plan-exit 确认卡出现「计划预览」折叠项，展开可见计划全文；
  3. 点「暂不执行」→ 本轮立即终止并显示收尾提示，会话留在 Plan 模式，下一条消息继续规划；
  4. build 模式拒绝某个 bash 权限卡 → 本轮同样终止（全局行为）；`continueLoopOnDeny: true` 时恢复旧行为；
  5. plan-exit 确认 → 切换 Build，切换提醒携带计划全文（lastPlans 锚定不受影响）。

## 文档同步

- `docs/dev/agent-loop.md` §2/§4：拒绝即停管线与终止条件表更新（原 `DeclinedError` 描述修正为 `UserRejectedError` + `denyStopReason` 实现）。
- `docs/dev/tools-and-permissions.md` §2.1/§3.3/§6：plan 工具行、询问流程、富输出回填（markdown → synthetic part 三处过滤）。
