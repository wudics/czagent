# 045 · agent loop 加固与压缩重构与分页修复

日期：2026-09-17
前置：044 合入后用户使用中反馈的四类稳定性/体验问题（loop 异常终止、压缩时灵时不灵、工具卡无执行中状态、markdown 渲染）；设计参考 `docs/ref/opencode-src`（prompt.ts / processor.ts / retry.ts / compaction.ts / markdown-stream.ts / ui components）。分三批实施并经一轮独立代码评审修复。

## 问题（用户反馈）

1. **agent loop 异常终止**：模型输出含"terminate"类文本后 loop 停止需手动续跑；偶发"未知 bash 工具"错误同样终止。
2. **上下文压缩时灵时不灵**：手动/自动压缩有时无任何效果也无提示；压缩后偶发请求 400。
3. **plan/write 等工具无执行中状态**：卡片直接以"已完成"出现（bash 因耗时长能看到 spinner，其余毫秒级完成被 React 批处理吞掉）。
4. **markdown 渲染**：是否需要渲染、流式重复解析开销、无消毒。
5. **压缩过程不可见**：手动压缩只有按钮文案"压缩中…"，切走会话再切回像被终止；压缩完成后摘要从时间线消失。
6. **聊天分页异常**：上拉先滚穿大片"正在加载历史…"才加载；下拉内容被过早销毁跳过中间消息。

## 根因（核实源码）

- **loop 终止三连**：openai-stream 只在 `finish_reason === 'tool_calls'` 时 flush 已聚合的工具调用（部分平台 GLM/Qwen 流出 tool_calls 后回 `stop` → 调用被静默丢弃 → runLoop 无工具可执行 break）；`!hadValid` break 把"全部未知工具"的错误结果烂在本地不回传模型；streamError 直接终局无循环级重试。
- **压缩**：`summarize` 整体 `catch { return null }` 吞掉一切失败（429/超时/摘要请求自身超限）；摘要请求无预算控制（old 区 10k 截断 × 298 条可数百 k token）；触发估算不计 tools schema、reserved 未扣 maxOutput、压缩后旧 usage 残留误判；checkpoint 渲染为对话中部 system 消息（部分后端拒绝）。
- **工具卡**：`tool-call-start/delta` 事件协议层已产出但 runLoop 只消费 post-stream 的 `tool-call`；text/reasoning 写死 parts[0]/parts[1]。
- **markdown**：全文缓存导致流式 O(n²) 重解析；`dangerouslySetInnerHTML` 无消毒（含失败回退路径）。
- **分页**：预载触发用概念索引 `first.index <= 4`（占位区要滚穿）；dropOldest 无滚动补偿（删除后其余项上移 Σ(实测−96) 视口跳变）且可能删到可见区。

## 变更

**A. Agent loop 加固（core/llm + core/node）**

- **`llm/engines/openai-stream.ts`**：任意 finish_reason 都 flush pendingTools（含无 choices 的纯 usage 终帧）；工具名规范化（trim、剥 `functions.` 前缀与 `:N` 后缀）；空名/JSON 解析失败产出带 `parseError` 的 tool-call（input=原始串）不再降级为文本；`tool-call-start` 宣告延迟到 id+name 均已知。
- **`llm/types.ts`**：tool-call 事件新增 `parseError?`。
- **`node/session-manager.ts`** runLoop：
  - 工具调用优先于 finish_reason（`turnToolCalls.length > 0` 即执行）；
  - 去掉 `!hadValid` break → 错误结果回传模型自我纠正，连续全无效 ≥3 轮才终止并给可见提示；
  - **循环级重试**：`LLMError.retryable`（429/网络/5xx）退避重发（总发送 ≤3，尊重 retryAfterMs），发 `session.retry` 事件；重试前清半截文本、pending/running 卡标 error（不追加 result，复用 callID 时卡片复活正常配对）；
  - **溢出自愈**：`context_overflow` → executeCompaction → 重建请求重试（仅 1 次不占重试次数）；
  - 工具卡消费 `tool-call-start`（流中即建 pending 卡）与 `tool-call`（按 callID upsert 为 running）；part 索引改 append-only 分配（text/reasoning 不再写死 0/1）；流式落库 200ms 节流；
  - `completeInterruptedTools` 覆盖 pending；runSubAgent 同口径（pending 卡 + stop 携带工具 + parseError + 流中失败清卡）。

**B. 压缩可靠性重构（core/compaction.ts + core/node）**

- **失败可见**：`summarize` 返回 `{summary?, error?}`，瞬态错误重试 1 次；自动压缩失败插可见 error part；手动压缩抛错给 UI 三态（成功/失败/没得压）。
- **摘要请求加固**：图片剥占位、工具输出截 2k（`truncateToolOutput` capOverride）、总预算 clamp(窗口−4k, 16k, 96k)、超限按消息粒度分块顺序摘要 + previousSummary 逐块合并。
- **触发估算修正**：`estimateToolsTokens` 计入 tools schema；`usable = contextLimit − max(reservedTokens, min(maxOutput, 32k))`；压缩后复查用纯估算（消除旧 usage 残留误触发）。
- **checkpoint 改 user 角色**进请求（不再发对话中部 system 消息）。
- **结构化摘要模板**（目标/结论/文件路径/偏好/未完成五小节）+ **`compaction.modelId` 摘要模型可配置**（设置页 GeneralTab 下拉）。

**C. 压缩可见性与调度（core + renderer）**

- **流式显示（对齐 opencode 时间线任务）**：`executeCompaction` 统一手动/自动路径——开始即发 `session.compacting{active,messageId}` + 占位块首帧，摘要 text-delta 经 `message.part.delta` 实时流入，完成后 checkpoint 以**同一 id** 落库并 `session.compacted` 归位。
- **单飞注册表** `compactingSessions`：同会话互斥（手动报"已在压缩中"、自动路径静默跳过）；`deleteSession` 中止压缩；落库前复核会话存在防孤儿 checkpoint。
- **手动压缩调度**：并行上限复用 `maxConcurrency` + FIFO 队列；拿槽位后复核状态并重读窗口；排队期间去重（manualCompactionQueued）。
- **跨会话存活**：渲染层 `compactingBySession` 注册表在事件守卫前更新；切回时按占位块 id 重建继续流式；RightPanel/StatusBanner 从注册表派生。成功/失败清理严格区分（tracker 仍指向该消息 = 失败才删占位块，防止误删已归位 checkpoint——评审修复）。
- **checkpoint 显示位置与语义边界解耦**：`createdAt = 完成时刻`（时间线底部原地保留，不再移到视口外数十条之上——用户反馈"完成后不见"的根因）；part 新增 `coversBefore`（尾部最旧一条 -1ms），`historyWindow` 按边界构窗（请求内容等价），旧格式回退定位式。

**D. 分页修复 + markdown 优化（renderer）**

- **ChatArea**：预载触发 `first.index − droppedCount ≤ 4`；下拉销毁限制在渲染窗口外（`safe = first.index − 12 − droppedCount`）+ 按 `measurementsCache` 实测高补偿 scrollTop（视口零跳动）；`dropOldest(count)` 显式化；`loadMoreTop` 函数式更新修竞态。
- **markdown worker**：块级增量渲染（`marked.lexer` 切块 + 块哈希 LRU 800，流式只重解析尾部块，O(n²)→O(尾部)）；useMarkdown 层 DOMPurify 消毒后缓存（失败回退转义纯文本，Markdown.tsx 回退同步转义）；两级缓存改真 LRU。
- **UI 组件**：`ToolStatusBadge` 渲染 pending（"准备中"）；`StatusBanner`（重试等待/运行中压缩）；`CompactionView` 流式态（空摘要 spinner、流式中自动展开）；MessageItem 渲染 user 角色 compaction 消息（原 CompactionView 为死代码——checkpoint 从未真正渲染，顺带修复）；GeneralTab 摘要模型下拉；i18n（toolPending/retrying/compactingSummary/summaryModel）。

## 评审修复（独立代码评审发现）

- **major**：成功压缩后 inactive 事件按 id 误删已归位 checkpoint → 改为仅 tracker 仍指向该消息（失败路径）才清理。
- minor：纯 usage 终帧 flush 工具调用；重试 sleep 的 abort 监听器泄漏；start 宣告延迟到 name 已知；压缩排队期间历史快照过期 → 槽位获取后重读；占位块角色不一致 → MessageItem 全宽分支按 part 类型判定（与角色无关）。

## 验证

- `packages/core` typecheck ✅；`pnpm test`：10 个测试文件 86 例全部通过 ✅（新增 `test/openai-stream.test.ts` 8 例：stop 携带 tool_calls flush、工具名规范化、parseError、空名、start 时序、usage 终帧 flush、estimateToolsTokens、truncate capOverride）。
- `packages/desktop` typecheck ✅；生产构建 ✅。
- 冒烟清单（待 UI 实测）：
  1. 模拟 stop+tool_calls / 畸形参数 / 未知工具 → loop 继续或模型自我纠正，不再无声终止；
  2. 429 → 重试条出现（第 x/3 次）→ 自动恢复；context_overflow → 自动压缩后重试；
  3. plan/write 工具卡片流中即出现"准备中"，完成后更新状态；
  4. 手动压缩：底部占位块流式生成摘要 → 完成原地变折叠条；切走再切回占位块恢复；压缩失败占位块消失且 DB 无残留；
  5. 多会话连续压缩并行 ≤ maxConcurrency、超出排队；删除会话中止其压缩；
  6. 长会话上下滚动：占位区随近随载、视口无跳动、中间内容不丢；
  7. 旧格式 checkpoint 的老会话正常打开与继续压缩（回退路径）。

## 文档同步

- `docs/dev/agent-loop.md` §1/§2/§4/§5/§6：主循环伪代码、事件消费与协议加固、终止条件表、压缩全节重写（触发/摘要加固/executeCompaction/coversBefore 窗口）、并发模型（压缩单飞+队列）。
- `docs/dev/data-model.md` §3/§5：MessagePart 补齐（synthetic/error/coversBefore）；持久化策略（200ms 节流、非破坏压缩）。
- `docs/dev/architecture.md` §4.2：SessionEvent 清单补全（compacted/compacting/retry/question/todo/context）。
- `docs/dev/ui-design.md` §3/§4：分页预载与安全销毁、markdown worker 管线、工具卡 pending 状态机、压缩流式显示、StatusBanner、跨会话压缩追踪。
