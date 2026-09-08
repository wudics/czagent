# 036 · todo 反序列化加固 + skill 截断豁免 + 用量逐轮刷新 + 滚动意图判钉

日期：2026-09-08
前置：用户使用中反馈四个问题——①任务清单显示 `0/1 [object Object]`；②skill 工具返回了完整内容，模型思考却声称"内容被截断"；③右侧 Token 统计要等整轮对话结束才更新，希望每次 LLM 交互都刷新；④流式输出中上滚看历史会被拉回底部，需在一次手势内抢出阈值。

## 现状结论（调研）

- **todo `[object Object]`**：tool schema 声明 `todos` 为字符串数组，但模型可能传对象数组；`execute` 里 `String((x)?.text ?? x)` 把无 `text` 字段的对象强转成字面量 `"[object Object]"`，经 `applyTodo`（同样 `String(raw)`）落库（`sessions.todo` 列）、广播、在 `RightPanel` 原样渲染。全程无校验拒绝。进度 `0/1` 本身正确，坏的是 item 文本。
- **skill 截断**：skill 工具返回完整 body（DB 也存全量，UI 可见完整），但 `buildRequestMessages` 对**所有** tool 结果套用 `truncateToolOutput`——超 3000 字符截断并加标记"工具输出已截断，完整内容可再次读取原文件"。主循环每轮从 DB 重建请求，模型下一轮看到的就是截断版+标记，说"被截断"是事实。且标记建议"重读原文件"是死路：模型不知道 SKILL.md 路径，重调 skill 工具拿到的仍是同一截断版。
- **用量滞后**：每轮 LLM 请求的 usage 已随 `finish` 事件到达（client `stream_options.include_usage`），主循环仅存局部变量 `providerUsage`，既不发事件也不落库；唯一 `session.usage` 发射在 `finalizeMessage`，而它只在整个 loop 退出后执行。IPC/UI 层本就即时广播、即到即更，只需改 core。子代理循环早已逐轮 `appendUsage`（但不发事件）。占用条（`panel.context`）读的是最后一条已 finalize 消息的 `m.tokens`，语义是"最后一次请求的上下文规模"，与累计总量是两个口径。
- **滚动拉锯**：钉底判定靠位置阈值 `NEAR_BOTTOM_PX=150`（距底 <150px 视为在底部）。流式时每条 delta 把视口拽回绝对底部（距离清零），慢滚每次都追不出 150px，形成拉锯；须趁 delta 间隙一次手势滚出阈值才能解钉。

## 决策（用户拍板）

- todo：**宽容提取 + 兜底报错**——对象条目依次尝试 `text`/`content`/`title`/`task` 字段；完全无法提取时返回含用法示例的错误让模型自纠，不再静默强转。
- 截断：**提高全局上限** 3000 → 10000，skill **额外豁免**（仅 32k 安全上限）。
- 用量：逐轮统计显示；**占用条也逐轮刷新**（新增逐轮事件，事件契约小改）。
- 滚动：**意图判钉**——上滚手势立即解钉，不依赖位置阈值。

## 变更

- **todo 加固**（`core/src/tools/todo.ts`）：新增 `extractTodoText`（字符串直接用；对象依次取 `text`/`content`/`title`/`task` 非空字符串字段）；`applyTodo` 改用它（畸形条目跳过）；`execute` 预校验，存在无法提取的条目即抛 `todos 格式错误…请改用 {"todos":["任务1","任务2"]}`（主循环 catch 进 `result.error`，模型可自纠）；schema 描述强调字符串数组并接受 `{text}` 对象；`TodoInput.todos` 类型放宽为 `(string | Record<string, unknown>)[]` 与宽容设计一致。
- **截断策略**（`core/src/compaction.ts` + `node/session-manager.ts`）：`TOOL_RESULT_TRUNCATE_CHARS` 3000→10000；新增 `FULL_RESULT_TOOLS`（`skill`）与 `FULL_RESULT_MAX_CHARS=32_000`，`truncateToolOutput(text, tool?)` 按工具选上限；`buildRequestMessages` 传 `cp.tool`。
- **用量逐轮刷新**（`core/src/provider.ts` + `node/session-manager.ts`）：
  - `SessionEvent` 新增 `{ type: 'session.context'; usage: Usage }`（本次请求用量 ≈ 当前上下文规模，与 `session.usage` 的会话累计值语义区分）；
  - 新增 `reportUsage(sessionId, modelId, usage, emitContext?)`：逐轮落库 + 广播累计（`session.usage`）+ 可选广播本次请求（`session.context`）；主循环 `finish` 分支调用（emitContext=true），子代理循环改为经它补发累计事件（不发 context，避免占用条跳到子代理上下文规模）；
  - `finalizeMessage` 仅在 `providerUsage === undefined`（provider 未回传，字符估算兜底）时才 `appendUsage`，防双计；`appendError`/错误路径透传 `providerUsage`，避免失败轮多记一条估算行。
- **占用条实时化**（`desktop/renderer`）：`stores/chat.ts` 增 `contextUsage` 状态（初始/reset 清空；`session.context` → set）；`RightPanel.tsx` 占用条取值优先 `contextUsage`（直播中每次请求都动），否则回退扫描已 finalize 消息的 `m.tokens`（重启/切会话仍准确）；事件已按 sessionId 过滤，跨会话无串扰。`mockProvider.ts` 对齐补发 `session.context`。
- **滚动意图判钉**（`desktop/renderer/components/layout/ChatArea.tsx`）：
  - 滚动容器增 `onWheel`（`deltaY < 0` 立即解钉）与 `onTouchStart`/`onTouchMove`（手指下滑 = 内容上滚 → 解钉），手势一发生即解除跟随，消灭"慢滚追不出阈值"的竞态；
  - 跟随效果 `setTimeout(0)` 回调执行前再校验 `followingRef`，防止已排程的滚动在用户刚解钉瞬间把人拽回；
  - `NEAR_BOTTOM_PX=150` 保留用于回钉（下滚回距底 150px 内重新钉底）；会话打开的钉底轮询本就尊重 `followingRef`，不受影响。
- **测试**（`core/test/`）：新增 `todo.test.ts` 9 项（字段提取矩阵、畸形输入报错含用法示例、同文本状态保留回归、statuses 回归）、`compaction.test.ts` 5 项（常规阈值截断/不截断、skill 豁免 10k~32k 区间、32k 上限仍截断、无工具名回归）。
- **文档**：`docs/dev/architecture.md` 事件契约补 `session.context`；`docs/dev/agent-loop.md` step-finish 改为逐轮落库+双广播；`docs/dev/data-model.md` `session_usage` 统计口径改为逐轮落行（含 finalize 兜底说明）。

## 验证

- `pnpm typecheck` ✅（core + desktop）· `pnpm test` ✅（core 33，含新增 14 项）。
- 行为核对：主循环工具抛错兜进 `result.error` 继续循环（模型自纠）；错误/中断路径 usage 不双计；`providerUsage` "最后一次请求"语义保留（compaction 判定不受影响）。
- 待 Electron 冒烟：①todo 传对象/畸形输入时模型收到报错并重试，清单不再出现 `[object Object]`；②加载 >10k 字符的 skill 后模型不再声称截断；③多轮工具调用中"Token 消耗"与占用条逐轮跳动、中途 abort 后总账一致、切会话后占用条恢复准确；④流式输出中轻滚滚轮即停住、滚回底部自动恢复跟随。
- 说明：已持久化的 `[object Object]` 脏数据不做迁移，重建清单即恢复。
