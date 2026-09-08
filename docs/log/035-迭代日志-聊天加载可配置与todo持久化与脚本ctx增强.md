# 035 · 聊天加载可配置化 + todo 持久化/自动收起 + 脚本 ctx 增强

日期：2026-09-07
前置：用户三项优化——①聊天显示（误以为按"30 次完整对话"加载）；②todo 面板重启后消失且进度三方不一致；③脚本 `ctx` 能力摸底与补强 + 同步《脚本编写指南》。

## 现状结论（调研）

- 聊天早已是按条数加载：`PAGE=50 / MAX_LOADED=200 / KEEP=150`（虚拟滚动 + beforeId 反向分页 + 向下裁剪），仅数值不符合"初始 10 条"的预期。
- todo 只存主进程内存 Map（`session-manager.ts` `todos`），028 拍板过"重启清空"；但 tool-result 已落库 → 重启后"面板空 / 内存空 / 模型上下文仍有旧清单"三方不一致，模型重发清单会把进度重置为 pending。
- 脚本 ctx 共 6 成员（session/tools/agent/log/ask/signal），不暴露 settings；`runScriptTool`/`runSubAgent` 漏传 `builtinSkillsDir`（内置技能在脚本/子代理中扫不到，疑似 bug）；子代理无 reportProgress、MCP 工具执行缺 def 兜底（registry 查不到必报"未知工具"）；指南 §7.1 "maxSteps 或 16" 与代码（留空=不限）不符。

## 决策（用户拍板）

- 聊天：初始 10 条 + 翻页 20 条，**均可配置**；内存窗口随页大小派生（上限 6 页、保留 5 页，下限 100/80 防抖动）。
- todo：**落库**到 `sessions.todo` JSON 列（重启恢复面板，重发清单按文本保留进度）；全部完成后**自动收起**（新活动自动展开，标题可手动切换）。
- 脚本 ctx：5 项全做——修 builtinSkillsDir、子代理补 reportProgress、`agent.run` 增 `maxSteps`/`mcpServers`、`ctx.tools` 单次超时、暴露 `ctx.settings.general` 只读快照（不含 API Key）。

## 变更

- **设置**（`core/src/provider.ts` + `settings-defaults.ts`）：`GeneralSettings` 增 `chatInitialMessages`（默认 10，范围 5–50）/ `chatPageMessages`（默认 20，范围 10–100）。
- **聊天加载**（`desktop/renderer/stores/chat.ts`）：常量改为 `chatLoadConfig()`——从 settings store 读配置并派生 `maxLoaded = max(page×6, 100)`、`keep = max(page×5, 80)`；`open`/`loadMoreTop`/`dropOldest` 全部改用派生值；删除无人引用的 `CHAT_PAGE/MAX_LOADED/KEEP` 导出。
- **设置 UI**（`GeneralTab.tsx` + zh-CN/en-US）：通用页新增两个数字输入（带范围钳制与说明文案）。
- **todo 持久化**（`core/src/storage/schema.ts` + `client.ts` + `repo.ts` + `node/session-manager.ts`）：
  - sessions 表增 `todo TEXT` 列，`migrate` 补 ALTER（历史会话 NULL = 未建立）；
  - `Storage.updateSessionTodo/getSessionTodo`（写 NULL 化空清单；读时过滤非法结构/损坏 JSON）；
  - `updateSessionTodo` 落库（失败不阻断工具返回）；`getSessionTodo` 内存 miss 时从 DB 恢复并回填（重启后面板与模型重发清单的进度保留由此打通）；
  - `deleteSession` 顺带清理内存 Map（此前只删 DB 行的小遗漏）。
- **todo 面板生命周期**（`RightPanel.tsx` + i18n）：全部完成自动折叠为摘要行（✓ n/n）；`session.todo` 更新（非全完成）自动展开；标题行可手动切换展开/收起；收起态摘要可点击展开。
- **脚本 ctx**（`core/src/script/types.ts` + `child.ts` + `node/session-manager.ts`）：
  - `ScriptAgentRunOptions` 增 `maxSteps?: number`（0/缺省=跟随 agent.steps，留空=不限）、`mcpServers?: string[]`（与 agent 生效名单取交集；传入后即使带 tools 白名单也可用 MCP 工具，白名单里写 `mcp_*` id 过滤）；未传 mcpServers 时维持旧行为；
  - `runSubAgent` 工具执行重构：先挂 running 卡片（reportProgress 实时更新标题）→ 完成后置态；MCP def 从本轮并入的 mcpTools 兜底查找（修复"未知工具"）；补 `builtinSkillsDir`；`maxSteps` 三级覆盖；
  - `runScriptTool` 补 `builtinSkillsDir` + `timeoutMs` 单次限时（per-call AbortController 链到会话信号，超时报 `工具调用超时（Ns）：tool`，finally 清理）；
  - `runScriptSession` 向子进程传 `settingsGeneral`；桥 handler 透传 timeoutMs；
  - `child.ts` PRELUDE：ctx 增 `settings`（`__SETTINGS_JSON__` 占位符）与 tools 二参 `{ timeoutMs }`；`ctx/session/settings` `Object.freeze`（含 general 深一层）；占位符改函数替换（防 JSON 内 `$` 序列被 `String.replace` 特殊展开）。
- **测试**（`core/test/script-ctx.test.ts` 新增）：端到端跑一次子进程桥——验证 ctx.settings 注入+冻结、`timeoutMs` 透传至 handler 且超时错误回传脚本、`agent.run` opts（maxSteps/mcpServers/tools）透传、ctx.session 冻结。
- **文档**：《脚本编写指南》§5/§6/§7/§12.2/§13/§14/§15/§16 同步（settings 快照、单次超时、agent.run 新参、PowerShell 跨平台示例、FAQ 两条）；`docs/dev/script-orchestration.md` 重写为 I14.1/I18 现行（删 vm/Python/modelRegistry 残留，标注内存上限未实现）；`docs/dev/data-model.md` sessions 表补 `todo` 列。

## 验证

- `pnpm typecheck` ✅（core + desktop）· `pnpm test` ✅（core 19：含新增 script-ctx 端到端）。
- 说明：本机 Node 20.15 直载 better-sqlite3 原生模块会段错误（沙箱 ABI 不兼容，桌面端 Electron 运行不受影响），故 todo 落库的 DB 层以 typecheck + 手动冒烟覆盖，未落 sqlite 单测（此前仓库也无 DB 测试）。
- 待 Electron 冒烟：①设置改初始/翻页条数后重开会话生效；②建 todo → 重启应用 → 回到会话面板恢复、模型重发清单进度保留；③全完成后自动收起、点击展开；④脚本 `ctx.settings.general` / 单次超时 / `agent.run` 新参。

## 后续修复 · 进入会话未滚动到底

用户反馈：打开会话只滚到中间。根因：旧版打开后 80/200ms 两次 `scrollToIndex` 兜底，赌不过异步渲染——消息真实高度由虚拟列表 `measureElement` + markdown worker（60ms 防抖）陆续生效，高度增长使视口漂移；漂移超 150px 时 `handleScroll` 判定"不在底部"把 `following` 置 false，跟随钉底永久停止，200ms 后再无修正。

修复（`ChatArea.tsx`）：

- `following` 增加同步镜像 `followingRef`（`setPinned` 统一维护），供钉底循环/滚动手势在回调里读取。
- 打开会话后（首个非空 `count` 到达时启动，每会话一次；离开后返回同一会话也会重新启动）改为**轮询钉底至稳定**：每 100ms 检查 `scrollHeight`，有变化即 `scrollTop = scrollHeight`（绝对底部，不依赖估算尺寸），连续 2 拍不变视为渲染稳定而结束，硬上限 2s；用户上滚或切走会话立即停止。
- 顺带：`jumpToBottom` 补 `align: 'end'`（原来默认对齐项顶部，非视觉底部）。
- 流式回复的跟随逻辑（totalSize 变化重钉）保持不变；钉底窗口内两套机制并存但都指向底部，无冲突。
