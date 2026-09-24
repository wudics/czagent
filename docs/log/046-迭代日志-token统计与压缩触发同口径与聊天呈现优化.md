# 046 · Token 统计与压缩触发同口径修复与聊天呈现优化

日期：2026-09-24
前置：045 合入后用户反馈三类问题（右侧 token 统计偏小、"33% 就开始自动压缩"、glm/qwen/agnes 做摘要模型时压缩失败）+ 聊天展示架构对齐诉求；设计参考 `docs/ref/opencode-src-2.0`（`packages/core/src/session/compaction.ts / usage.ts / runner/step.ts`、`packages/ai` usage 字段语义、`packages/app|session-ui` 时间线：意图驱动跟随、`pinned` 状态机、`data-scrollable` 嵌套滚动豁免、BasicTool 合并卡与 Think 折叠）。

## 问题（用户反馈）

1. **右侧 Token 消耗统计不正确**：工具调用轮次产生的 token 像是有没记录。
2. **上下文占比计算是否正确的质疑 + 压缩触发异常**：面板显示 ~33% 就开始自动压缩。
3. **自动压缩失败**：摘要模型选 glm-5.3-flash / qwen3.8-flash / agnes-2.5-flash 报"上下文自动压缩失败：模型未返回摘要内容"，siliconflow deepseek v4 flash 正常。
4. **聊天展示优化诉求**（技术架构：滚动跟随/解钉意图/向上阅读/向下跟随；方式：思考/工具调用/正文呈现）。

## 根因（源码核实）

- **finish 即丢 usage（主因）**：OpenAI 兼容协议（含 `stream_options.include_usage`）把 usage 放在 `finish_reason` 帧**之后**的独立空 choices 帧；旧实现见 finish_reason 即 `cancelBody(); return`（防部分平台挂流的初衷），把尾帧连同全部真实 usage 一起丢弃 → 逐轮 `reportUsage` 不触发，面板只剩 finalize 阶段"最后一条消息的字符粗估"，工具轮次（占大头）完全隐身；压缩锚点 `lastUsageTokens` 恒为 0，触发判定退化为纯字符估算（系统性偏小，逼近上限才触发）。
- **三套占用口径互相打架**：触发线 `max(字符估算+toolsTokens, lastUsageTokens)`、`getSessionContext`/仪表"有 checkpoint 用纯估算、无则 max"、finalize 又一套——叠加 DeepSeek 系 usageTotal **重复累加子集字段**（input 已含 cacheRead/Write、output 已含 reasoning，旧口径五者相加：90% 缓存命中时虚高 2~3 倍）→ 锚点一旦存在就虚高，"面板 33%、触发线 ≥88%"同屏出现，观感即 33% 就压。
- **"模型未返回摘要内容"= thinking 吃满输出预算**：`summarizeOnce` 强制 `thinking:'off' + maxTokens:2048` 且只收集 text-delta。thinking-only 后端（参数被忽略/关思考仍出 reasoning 流）下 2048 全部消耗在 reasoning_content、正文恒空 → 报错；siliconflow deepseek 关思考真实生效所以正常。摘要旁路成本不入账：压缩/标题/图片理解三处全都不记 usage。
- **压缩机制毛边**：自动压缩失败后每轮重试（一轮 2 次失败调用的成倍时间与 token 浪费、每轮挂起）；仍超限只丢 1 条最旧；请求窗口 300 条 + "条数饱和"强制全窗压缩与占用无关（33% 也照压）。

## 变更

**A. Token 统计与占用口径统一（core/llm + node + storage）**

- `llm/engines/openai-stream.ts`：**finish 后 usage 尾帧捕获**——finish_reason 帧无内联 usage 时宽限读（总时限 1200ms / ≤16 帧，流结束/[DONE]/超时立即退出），拿到后**合并发射一条** `finish`（不拖延循环判据）再断流；全程无 usage 保持 `usage: undefined`（调用方字符估算兜底）。正常流零额外延迟（[DONE] 即时结束）。
- `storage`：新增 `updateMessageTokens(id, usage)`——每轮 finish 把**该轮真实 usage** 写入该轮 assistant 消息（压缩锚点数据源）；`compaction.ts`：`usageTotal` 改为 **input+output**（子集字段不再相加；与 opencode 互斥五字段全加数值等价），新增 **`estimateContextUsed(history, fallback)`**（opencode 风格锚点+增量：锚点=最后 checkpoint 之后最近一条带真实 usage(input>0) 的 assistant，est=usageTotal(锚点)+锚点后各消息估算；无锚点→纯估算 fallback；checkpoint 后无新锚点自动 fallback，杜绝旧窗口 usage 误判"仍超限"）与 `findLastCompactionIndex` 公用。
- runLoop 触发线、实时仪表、`getSessionContext`、`finalizeMessage` 兜底（乱序字符公式→`estimateTokens`）**全部收敛到同一口径**；右侧面板"输入/输出/思考"补"其中思考 / 其中缓存命中"明细行（展示语义，不影响总量）。

**B. 摘要健壮性与旁路入账（压缩修复 + 防复发）**

- `summarizeOnce(sessionId, target, chunk, thinking, ...)`：**思考模式跟随会话**（缺省 auto，不再强制 off——opencode 压缩根本不关思考）；**空正文兜底链**：text 空 → 取 `stripThinkTags(reasoning)`（glm-5.x-flash/agnes-2.5-flash 这类"只吐思考"平台可成摘要）；仍空 → **2048→8192 提额重试一次**（防思考吃满/length 截断；`retryable=false` 的 auth/invalid 不重烧）；错误信息携带 `（finish=length）`/`（finish=tool_calls）` 诊断。
- 摘要请求自身的 usage 计入会话（按摘要模型 id 落 session_usage 行）；同理 `generateTitle`（含 thinking-only 标题兜底：正文空取思考流首行）、`describeImage`。

**C. 自动压缩机制加固**

- **run 级熔断** `autoCompactGaveUp`：发送前自动压缩失败一次 → 本次运行后续轮不再尝试（error part 只插一次），溢出自愈路径保留每轮独立一次机会；防失败风暴（每轮 2× 失败调用的时间与费用浪费）。
- 仍超限的机械降级从"丢 1 条"改为**循环丢最旧非 checkpoint 消息**（保留 checkpoint 与最新两条、≤64 轮防 O(n²) 病态），压缩失败/无摘要可压时本轮请求仍尽量合规发出。
- 请求窗口 `historyWindow` 300 → `HISTORY_WINDOW_MESSAGES=2000`；**饱和强制压缩加占用门槛**：`est ≥ usable×0.5`（limit 未知时退化为 `est ≥ 50k`）才因条数触发——低占比超长会话不再无脑全窗压缩（"33% 就压"的次级触发路径）。

**D. 聊天展示（对齐 opencode session-ui 时间线）**

- **意图驱动跟随（ChatArea）**：解钉/吸钉改看**滚动方向**——任一来源上移（滚轮/拖拽滚动条/键盘/触屏下拉）立即解钉，近底且下移才恢复吸附；程序性位移豁免（预载锚定回跳 `anchorTxRef`、dropOldest 补偿同步刷新基线 `lastTopRef`），消灭"底部 150px 内慢滚阅读被每帧拉回"的拉锯竞态。
- **卡内滚动区豁免**：工具结果/参数/思考正文加 `data-scrollable`，区内滚轮/触控不再误触解钉（opencode touchNested 同款）。
- **回底按钮新消息徽标**：解钉期间新到达消息计数，按钮文案"N 条新内容"，恢复跟随/切会话清零。
- **思考（reasoning）呈现**：part 新增 `time?: {start,end}`（runLoop 逐 delta 计时：首个思考 delta=start，首个正文/工具或流终点=end，重试清理复位）；**流式中自动展开实时滚动**（有界 max-h 56，防布局跳），**完成自动折叠**为一行「已思考 · Ns」；用户手动开合后不再自动折叠；历史消息（含无 time 老数据）按完成态默认折叠。
- **工具合并卡（对齐 BasicTool）**：`MessageItem.toRenderItems` 按 callID 把 tool-result 配进所属 tool-call **单张折叠卡**（孤儿 result 独立兜底）；标题行=工具名+入参摘要（≤90 字紧凑 JSON）/进度标题+状态徽标；执行中默认展开、完成/失败自动折叠、历史挂载即折叠——tool 密集会话 DOM 与视觉噪音大幅下降；卡片状态徽标/pending 占位行为不变。

## 验证

- core 测试 86 → **95 全绿**：openai-stream 新增 finish 后独立 usage 尾帧/无 usage/usage 内联三用例（含 `[DONE]` 零宽限延迟断言）；compaction 新增 usageTotal 去重（10500 断言锚定）、estimateContextUsed 锚点+增量/无锚 fallback/checkpoint 后旧锚失效/新锚生效四用例。
- `pnpm -r typecheck`、`pnpm -r test`、`electron-vite build` 全过。

## 用户反馈（验收要点）

- 真实对话数轮 + 工具多轮：右侧"累计/输入/输出"应与供应商控制台同量级（不再只有末轮字符估算）；ContextMeter 百分比与压缩触发线一致（不再 33% 触发）。
- 压缩模型选 glm/qwen/agnes：应能出摘要（可能取思考流兜底）；失败一次后不再每轮反复"正在生成摘要"挂起。
- 长会话向上慢滚阅读不被流式输出拉回底部；回底按钮显示新消息数；历史思考/工具卡默认折叠、展开有界滚动。

## 遗留（本次未做，候选后续）

- 摘要模板校验与追问重试（opencode `hasSummarySection` + 不合规再问一轮）本次以兜底链替代，未引入。
- 空闲预压缩（轮末后台提前压）、压缩模型失败 → 会话模型降级链、`context_overflow` 文案带阈值提示——候选增强。
- 子代理/多模态生成类调用成本独立归因（现并入同一 session_usage 总量）。
