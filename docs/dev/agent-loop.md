# Agent Loop 与上下文压缩

> 对应 PLAN.md 决策 #11、#15、#18、#21。设计参考 `docs/ref/opencode-1.18.19-src/packages/opencode/src/session/prompt.ts`（V1 runLoop）、`packages/core/src/session/runner/llm.ts`（V2）、`packages/opencode/src/session/compaction.ts`、`overflow.ts`。

## 1. 主循环（伪代码）

```
async function runLoop(session, agent):
  turn = 1
  while true:
    if turn > maxSteps: stepsExhausted=true; break
    # 每轮按会话当前配置解析 agent/model/tools（plan→build 切换、中途换模型下一轮生效）
    tools = resolveTools(agent, webAccess, mcpTools)
    # 上下文压缩：溢出检测（估算 ∨ 上次真实 usage，含 tools schema 体积）→ executeCompaction
    #   → 压缩后纯估算复查 → 仍超限丢最旧一条重试 ≤1（详见 §5）
    # 组装请求（checkpoint 以 user 角色渲染；逐轮 system-reminder 拼最后一条消息）
    messages = buildRequestMessages(history, system, env, reminder)
    request = { messages, tools }
    # ---- 发送 + 循环级重试 / 溢出自愈 ----
    attempt = 1
    loop:
      events = llm.stream(request); consumeEvents(events)      # 增量持久化 parts（delta 落库 200ms 节流）
      if aborted: 补齐中断工具卡; break
      if streamError:
        if kind == context_overflow and 未自愈过:
          executeCompaction(); 重建请求; 清半截文本; continue loop   # 不占重试次数
        if retryable and attempt < 3:
          emit session.retry(attempt, delay)                     # UI 显示重试等待条
          sleep(max(retryAfterMs, 2s*2^n)); 清半截文本; continue loop
        appendError(); break                                     # auth/quota/invalid → 错误终局
      # 工具调用优先于 finish_reason（部分平台 stop 也携带 tool_calls，对齐 opencode）
      if turnToolCalls.length > 0:
        执行工具（权限/doom-loop/富输出），错误结果回传模型
        if 全部无效: invalidTurns++; >=3 → 可见提示后 break; else continue
        invalidTurns = 0; turn++; continue
      break                                                      # 纯文本回复 → 结束
```

## 2. 单次 turn 的事件消费（`consumeEvents`，session-manager.ts）

- 订阅统一 `LLMEvent` 流（见 llm-engine.md §3），增量持久化到 `messages.parts`：
  - `text-delta` / `reasoning-delta` → text/reasoning part 累积（part 索引 append-only 分配，不写死槽位）
  - **`tool-call-start` → 流中即建 pending 卡片**（模型一开始发工具调用就立即可见，不等整条流结束；按 callID 去重）
  - `tool-call` → 按 callID **upsert** 卡片 pending→running（携带解析后的 input；`parseError` 标记参数非法）
  - `finish` → usage 逐轮落库 + 广播 `session.usage` / `session.context`
- **流式落库节流**：delta 高频更新仅发事件，`updateMessageParts` 以 200ms 节流（结束时 `finalizeMessage` 兜底全量落库）。
- **协议层加固（openai-stream.ts）**：
  - **任意 finish_reason 都 flush 已聚合的工具调用**——部分 OpenAI 兼容平台（GLM/Qwen 部署）流出 tool_calls 增量后回 `finish_reason=stop`，只认 tool_calls 会把调用静默丢弃导致 loop 误终止（对齐 opencode：stop+有工具调用也要继续）；无 choices 的纯 usage 终帧同样 flush。
  - **工具名规范化**：trim、剥 `functions.` 前缀与 `:N` 后缀，避免"未知工具"误判。
  - **畸形参数不再降级为文本**：空工具名 / 参数非合法 JSON → 产出带 `parseError` 的 tool-call，由 runLoop 合成错误 tool-result 回传模型自我纠正。
  - `tool-call-start` 宣告延迟到 id+name 均已知（callID 是调用方 upsert/去重键）。
- **工具执行**：post-stream 逐个执行（见 tools-and-permissions.md）：
  - 权限断言；doom-loop：同工具同参连续 3 次 → 询问用户
  - 未知/空工具/参数解析失败 → 合成错误 tool-result 回传（不终止 loop）；错误结果让模型下一轮自我纠正
  - 富输出：图片/文件/markdown 追加为独立可见 part，模型只收文本
- **权限拒绝 → 停止循环**（决策 18 配套，对齐 opencode 默认）：权限层 deny 或工具内部 `ctx.ask` 拒绝（`UserRejectedError`，tools/types.ts）→ `denyStopReason` 记录 → 本轮工具结算完即 break，不再发起下一次请求；循环外加一条用户可见收尾提示。`general.continueLoopOnDeny = true` 可恢复旧的"错误反馈给模型继续跑"行为。子代理循环内拒绝行为不变。
- **循环级重试**（对齐 opencode retry.ts）：`LLMError.retryable`（429/网络/5xx）→ 退避重发本 turn（总发送 ≤3 次，尊重 `retryAfterMs`），期间发 `session.retry` 事件供 UI 显示等待条；重试前清空半截文本（重发从头生成）、pending/running 工具卡标记 error（不追加 result，复用 callID 时卡片复活并正常配对）。`auth/quota/invalid` 不重试。
- **溢出自愈**：`context_overflow` → `executeCompaction()` 后重建请求重试本轮（仅一次，不占重试次数；与 opencode `needsCompaction` 同思路）。

## 3. System Prompt 组成

```
system = [
  BASE_PROMPT,                             # 基础行为规范（代码常量，settings-defaults.ts；随版本演进免迁移）
  agent.prompt,                            # build/plan/自定义 agent 的系统提示词（用户可编辑，composeSystemPrompt 拼接）
  <env>                                    # 平台/OS/会话 cwd/日期 + Git 仓库状态（分支，cwd 缓存）
                                           #   + <project_instructions>（AGENTS.md，mtime 缓存，截 10k 字符）
                                           #   + <available_skills>（技能名+描述+使用指引）
                                           #   + <mcp_instructions>（MCP 工具清单）
]
# 子代理（task 派遣）：composeSystemPrompt(agent) + SUB_AGENT_ADDENDUM（自包含报告/不提问约束）
```

- 内置 `build`（默认）：完整工具集，自主完成任务。
- 内置 `plan`：只读工具集 + plan 提示词（先调研、列计划、不擅自改代码），可被 agent 通过 `plan` 工具进入、`plan-exit` 退出（决策 18，参考 opencode `plan-enter/plan-exit.txt`）。
- 提示词文案可直接参考 `docs/ref/opencode-prompt-cn/` 的中文版。
- 项目指令：仅识别会话 cwd 下的 `AGENTS.md`（`core/src/instructions.ts`），实例级 mtime+size 缓存；空文件不产生注入段。

### 3.1 逐轮 `<system-reminder>` 注入（`core/src/reminders.ts`）

请求时拼装、**不落库**：`buildRequestMessages()` 末尾把 `buildTurnReminder(ctx)` 的结果以 `<system-reminder>` 块追加到消息数组**最后一条消息**（新输入轮为 user，工具续轮为 tool；与 todo 工具结果尾注同一先例）。token 计入 `estimateRequestTokens`（预算口径正确）。四类触发条件：

| 提醒 | 条件 | 作用 |
|---|---|---|
| Plan 只读约束 | `agentId === 'plan'`（每轮） | 只读约束不随长上下文稀释，明确"优先于历史中的修改请求" |
| 模式切换锚定 | `prevAgentId==='plan' && agentId==='build'`（仅切换后首轮） | 携带 `lastPlans` 缓存的计划全文（截 4000 字符），防止重新调研/偏离已批准范围 |
| todo 进度快照 | 清单存在且未全 completed（每轮） | 复用 todoToText 渲染（截 1500 字符），防进度漂移 |
| max-steps 预警 | 上限有限且剩余 ≤3 轮 | 要求收尾汇总，不开启新的大步骤 |

配套：`ToolContext.savePlan` 由 plan 工具调用缓存计划文本（SessionManager 内存 Map，会话删除时清理）；`prevAgentId` 在每轮请求组装后更新。

## 4. 终止条件与 max steps

| 情形 | 行为 |
|---|---|
| 正常完成 | 无工具调用可执行（`turnToolCalls.length === 0`）→ break（**工具调用优先于 finish_reason**） |
| 达到 maxSteps | `agent.steps`（留空=不限）→ stepsExhausted，break + 用户可见提示 |
| 权限拒绝 | 中断循环（denyStopReason → break + 收尾提示；`continueLoopOnDeny=true` 则错误反馈继续） |
| 可重试错误（429/网络/5xx） | 循环级退避重试，总发送 ≤3 次（`session.retry` 事件 + UI 等待条；尊重 retryAfterMs） |
| context_overflow | 压缩自愈（executeCompaction → 重建请求重试，仅 1 次）→ 仍失败才错误终局 |
| 不可重试错误（auth/quota/invalid） | appendError → break |
| 连续全无效工具调用 ≥3 轮 | 可见提示后 break（防未知工具死循环空转；错误结果每轮都回传模型自我纠正） |
| 用户 stop | IPC `session:stop` → AbortController 中断 stream + 中断工具（pending/running 卡补 error 结果保证配对） |

## 5. 上下文压缩（决策 11，session-manager.ts + compaction.ts）

### 5.1 Token 估算（compaction.ts）
- `estimateTokens`：CJK ≈1.5 字/token，其余 ≈4 字符/token；`estimateRequestTokens` 叠加消息/部件开销与图片固定值。
- **工具 schema 体积计入触发估算**（`estimateToolsTokens`）：tools 数组随请求发送并占窗口，但不在消息估算内。

### 5.2 溢出检测与触发
```
usable = contextLimit − max(reservedTokens, min(maxOutput, 32k))   # 输出占窗口（对齐 opencode）
est    = max(estimateRequestTokens(requestMessages) + toolsTokens, lastUsageTokens(history))
触发   = (usable 已知 && est >= usable) || 窗口饱和（>300 条且窗口内无 checkpoint）
```
- contextLimit≤0 或 auto=false → 不自动压缩。
- 压缩后复查用**纯估算**（checkpoint 已存在，压缩前的旧 usage 口径失效会误判仍超限）。

### 5.3 摘要生成（加固）
- **摘要模型可配置**：`general.compaction.modelId`（留空=会话当前模型；可用便宜快速的模型）。
- **结构化模板**：任务目标与背景 / 已完成与关键结论 / 重要文件与路径 / 用户偏好与约束 / 未完成事项与下一步。
- **请求加固**：图片剥占位、工具输出截 2k（`toolOutputMaxChars`）、总预算上限（clamp(窗口−4k, 16k, 96k)），超限按消息粒度**分块顺序摘要并用 previousSummary 逐块合并**（call/result 同属一条 assistant 消息，按消息切分不拆散配对）。
- **错误不再吞掉**：返回 `{summary?, error?}`；瞬态错误（限流/网络/服务异常）重试 1 次；失败对用户可见（自动路径插 error part / 手动路径抛错给 UI 三态区分）。

### 5.4 checkpoint 落库与窗口构建
- checkpoint 为 **user 角色消息**（`{type:'compaction', summary, coversBefore}`，不用对话中部 system：部分 OpenAI 兼容后端拒绝）。
- **显示位置 = 压缩完成时刻**（时间线底部原地保留，流式摘要完成后原地变折叠条，随新对话自然上移）；**语义边界 = `coversBefore`（尾部最旧一条 -1ms）**——显示位置与窗口边界解耦。
- `historyWindow`：找到最后一个 checkpoint → 窗口 = `[checkpoint, ...createdAt > coversBefore 的原文]`；无 checkpoint → 全量；旧格式（无 coversBefore）回退按消息定位切窗。多个 checkpoint 以最后一个为准（更早的已被合并且被边界过滤）。
- **尾部保留**：`tailBudget = clamp(usable × preserveRatio, 2k, 15k)` + 条数上限 200；`pruneHistory` 请求侧清理旧工具输出（40k 保护线，DB 不动）。

### 5.5 压缩执行（executeCompaction，手动/自动统一）
- **流式可见（对齐 opencode 时间线任务）**：压缩开始即在时间线底部建占位块（"正在生成摘要…"spinner），摘要 text-delta 经 `message.part.delta` 实时流入；完成后 checkpoint 以**同一 id** 归位（渲染层按 id 原地替换）。
- **单飞注册表** `compactingSessions`：同会话同时只允许一个压缩任务（手动再触发报"已在压缩中"，runLoop 自动路径静默跳过本轮）。
- **手动路径调度**：并行上限复用 `maxConcurrency`，FIFO 队列（`acquireCompactionSlot`）；拿槽位后复核会话状态并重读窗口（排队期间可能已运行/删除）；仅限 idle 会话。自动路径随 runLoop 并发天然受限，不入队。
- **失败清理**：inactive 事件携带 messageId，渲染层仅在 tracker 仍指向该消息（= 失败，`session.compacted` 未先到）时移除占位块；成功路径 checkpoint 按同 id 归位。DB 只在成功后写 checkpoint（失败无残留）。
- **删除会话**：中止该会话进行中的压缩（注册表 controller）；落库前复核会话存在，避免孤儿 checkpoint。
- **溢出自愈联动**：runLoop 发送前触发压缩失败 → assistant 消息插可见 error part（循环继续，请求若真溢出还会走自愈）；流中溢出 → 自愈压缩后重试本轮。

## 6. 多会话并发（决策 21）

```
SessionManager
  ├─ aborts: Map<sessionId, AbortController>        # running 会话
  ├─ queue: []                                      # 超并发上限的对话排队
  ├─ compactingSessions: Map<sessionId, 任务>        # 压缩单飞注册表（手动/自动互斥）
  ├─ compactionQueue + compactionActive             # 手动压缩 FIFO 排队（上限复用 maxConcurrency）
  └─ concurrencyCap = maxConcurrency（默认 4，可配置）
```

- 对话 runLoop 与压缩任务相互独立并行：压缩跨会话切换存活（切换只改渲染层 focus）。
- 事件统一带 `sessionId` 推给 IPC（架构 §4.2）。
- UI 并发占用：会话栏显示运行中/排队徽标。
- 删除会话：中止对话 loop + 中止该会话压缩任务。
