# Agent Loop 与上下文压缩

> 对应 PLAN.md 决策 #11、#15、#18、#21。设计参考 `docs/ref/opencode-1.18.19-src/packages/opencode/src/session/prompt.ts`（V1 runLoop）、`packages/core/src/session/runner/llm.ts`（V2）、`packages/opencode/src/session/compaction.ts`、`overflow.ts`。

## 1. 主循环（伪代码）

```
async function runLoop(session, agent):
  step = 1
  while true:
    msgs = loadHistory(session)                     # 过滤已压缩段
    lastAssistant = 最后一条 assistant
    # 前置终止判定（参考 opencode prompt.ts:1111-1130）
    if lastAssistant.finish != 'tool-calls' and 无遗留工具调用:
        break
    # step 1：后台生成标题/摘要
    if step == 1: spawn(titleGeneration, summaryGeneration)
    # 处理待办：compaction 队列
    if pendingCompaction: 执行压缩; 若返回 stop → break
    # 取 agent 配置（build/plan/自定义），maxSteps = agent.steps
    isLastStep = step >= maxSteps
    # 组装 system prompt（见 §3）
    system = buildSystemPrompt(session, agent)
    # 解析工具（按权限过滤；isLastStep 时 tools=[] + toolChoice=none + MAX_STEPS 提示）
    tools = isLastStep ? [] : resolveTools(agent.permissions)
    # 组装 messages（isLastStep 时追加 MAX_STEPS_PROMPT）
    messages = toModelMessages(msgs) + (isLastStep ? [assistant(MAX_STEPS_PROMPT)] : [])
    # 单次 provider turn：调用协议层 stream，消费 LLMEvent
    events = llm.stream({ model, system, messages, tools, toolChoice })
    stepOutcome = consumeEvents(events)             # 增量持久化 parts
    if stepOutcome == 'stop':        break
    if stepOutcome == 'compact':     enqueueCompaction(); continue
    # 有 tool-call 则继续下一轮把工具结果送回模型
    step++
```

## 2. 单次 turn 的事件消费（`consumeEvents`）

- 订阅统一 `LLMEvent` 流（见 llm-engine.md §3）。
- 每个事件增量持久化到 `messages.parts`：
  - `text-start/delta/end` → text part 追加
  - `reasoning-*` → reasoning part 追加（决策 15：同一条消息内联，不拆开）
  - `tool-input-*` → 工具参数流式累积
  - `tool-call` → 创建/更新 tool-call part（state=running）
  - `tool-result` → 完成 tool-call part（state=completed），写入 output/metadata/attachments
  - `tool-error` → part 置 error 状态
  - `step-finish` → 记录 usage → 逐轮落库 session_usage 并广播 `session.usage`（会话累计）与 `session.context`（本次请求用量，供右侧占用条实时刷新，仅主循环）
- **工具执行**：`tool-call` 到达即异步执行（不阻塞流）：
  - 执行前权限断言（`ctx.ask` / permission service，见 tools-and-permissions.md）
  - doom-loop 检测：同一工具同一参数连续 3 次 → 询问用户（参考 processor.ts:356-379）
  - 结果经 `ToolOutput` 规范化（输出上限、图片附件压缩）→ 发布 `tool-result` 事件
- **权限拒绝 → 停止循环**（决策 18 的配套行为）：`DeclinedError` → 剩余未结算工具标记失败，中断本 loop。
- **错误处理**：LLMError 分类（认证/配额/限流/context-overflow/未知）挂到 assistant 消息并停止或按策略重试；`context-overflow` → 触发压缩重跑（见 §5）。

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
| 正常完成 | 上轮 finish 非 tool-calls 且无遗留工具 → break |
| 达到 maxSteps | `agent.steps`（默认 Infinity）→ 最后一轮禁用工具（`toolChoice=none`）并追加 MAX_STEPS_PROMPT 要求"只总结已完成/未完成，不再调工具" |
| 权限拒绝 | 中断循环（failUnsettledTools + halt） |
| 用户 stop | IPC `session:stop` → AbortController 中断 stream + 中断工具 |
| provider 错误 | 分类处理，挂错误消息，停止 |

## 5. 上下文压缩（决策 11）

### 5.1 Token 估算
`Token.estimate = round(chars / 4)`（参考 `packages/core/src/util/token.ts`）。流式过程实时累计。

### 5.2 溢出检测
```
usable(context, model) =
  context = model.limit.context
  reserved = compaction.reserved ?? min(20_000, maxOutputTokens)
  usable = max(0, context - reserved)
isOverflow = (tokens.total >= usable) && compaction.auto !== false
```

### 5.3 压缩流程
1. **触发**：turn 结束检测到溢出，或 provider 返回 context-overflow 错误。
2. **切分**：从尾部向前累计，保留最近窗口 `preserveRecent = min(15_000, max(2_000, usable*25%))`；其余为 head。
3. **摘要**：调用对话模型，以结构化 prompt 生成摘要（Objective / 关键细节 / 工作状态 / 下一步 / 相关文件），`tools=[]`、maxTokens≈4096。
4. **checkpoint 回填**：摘要 + 最近窗口作为 `compaction` 类型消息进入下一轮上下文（渲染时以独立样式展示"已压缩的历史摘要"）。
5. **工具输出截断**：单次工具输出超限（如 2000 chars 的展示上限 / 40k token 保护线）时截断/标记 compacted，`PRUNE_MINIMUM=20k` 才真正清理。
6. **overflow 重跑**：压缩成功后用新历史重建请求重跑该 turn（**最多 1 次**），避免死循环。

> 记忆隔离：每个会话独立预算与压缩状态，互不影响（决策 21 的记忆隔离要求）。

## 6. 多会话并发（决策 21）

```
SessionManager
  ├─ runRegistry: Map<sessionId, SessionRuntime>   # running 会话驻留内存
  ├─ queue: []                                      # 超并发上限的任务排队
  └─ concurrencyCap = 4（可配置）
```

- 每个 `SessionRuntime` 独立 `runLoop` + 独立 `AbortController`。
- 事件统一经 `EventBus` 打上 `sessionId` 推给 IPC（架构 §4.2）。
- 会话切换只改渲染层 focus，不打断 running loop。
- UI 并发占用：会话栏显示运行中/排队徽标。
