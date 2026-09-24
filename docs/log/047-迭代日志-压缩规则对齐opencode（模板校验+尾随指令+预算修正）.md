# 047 · 压缩规则对齐 opencode（模板校验 + 尾随指令 + 输出预算修正）

日期：2026-09-24
前置：046 修复后真机复验仍有两类问题；用户指定"直接学习 opencode 的压缩规则"（参考 `docs/ref/opencode-src-2.0/packages/core/src/session/compaction.ts` 逐行对照）。

## 问题（用户反馈）

1. **agnes-2.5-flash 手动压缩直接 400**：`Error invoking remote method 'session:compact': ... OpenAIException - "No user query found in messages." (BadRequest 400)`。
2. **qwen3.8-flash 压缩**：占位块能流式看到一些内容，但输出一会儿就报错。
3. 总诉求：opencode 的压缩同样允许模型输出思考内容却能稳定成功，czagent 为什么不一开始就照它的规则做。

## 根因（对照 opencode 压缩源码）

- **摘要请求结构与 opencode 不一致（agnes 400 的实锤根因）**：opencode 是把摘要指令作为**最后一条 user 消息**追加在真实 transcript 之后（`Message.user(buildPrompt(...))`，compaction.ts:630），请求恒有 user 轮；czagent `summarizeOnce` 把指令塞进 **system**、后面只拼分块后的历史——手动压缩时 old 区/某 chunk 完全可能没有 user 角色消息（全是 assistant/tool 轮），vLLM 系后端（agnes 上游，Qwen chat template）此时抛 `No user query found in messages`。
- **输出预算自伤（qwen 流一半出错的主因）**：opencode 压缩请求 = 会话模型常规配置（不关思考、输出预算为模型档，32k 封顶参与触发线计算）；czagent 首请求 `maxTokens: 2048`。qwen3.8-flash 这类 thinking 模型先烧思考再成文，2048 被吃满 → 正文截半/为空 → 旧兜底链再 800ms 提额重试，多 chunk 场景某块失败即整体报错；即便成功，截半内容也直接进 checkpoint。
- **无结构校验（压后失忆的根源）**：opencode 有 `hasSummarySection`（模板 `##` 标题逐行匹配）+ 校验失败**追问重试一次**（"上一轮回复未填模板。不要调用工具。仅按模板标题以文本返回摘要"，两请求共享重试预算、usage 累加）；czagent 正文非空即定稿，半截与散文摘要照单全收。

## 变更（移植规则，不搬 Effect 架构）

- **`compaction.ts` 新增摘要规则常量（纯函数可单测）**：
  - `buildSummaryInstruction(previousSummary?)`：opencode `SUMMARY_TEMPLATE + SUMMARY_RULES + buildPrompt` 的本地化——七段模板（任务目标 / 要求与约束 / 决定 / 工作状态 / 下一步 / 相关文件 / 关键上下文）+ 写作规则（短单行要点、精确保留路径/符号/命令/错误原文/URL、只带未解决问题且保留原话、保留未提交/已提交等工作流状态、不复述非用户口述的设定、不提及压缩过程）+「不要继续任务、不要调用任何工具、只返回小节正文」；有既有摘要时切换为**合并指令**并把 previousSummary 以 `<既有摘要>` 块内联（对应 opencode `buildPrompt(update=true)`）。
  - `SUMMARY_HEADINGS` **由模板逐行派生**（opencode 防漂移技巧——改模板措辞，校验集自动跟随）；`hasSummarySection(text)` 逐行 trim 精确命中即合规；`SUMMARY_REMINDER` 追问文案。
- **`summarizeOnce` 重写为 opencode 两请求循环**（每 chunk ≤2 次调用）：
  - 请求 = 历史消息 + **指令尾随 user 消息**（不再放 system）——恒有 user 轮，根除 `No user query found` 类 400，指令也更贴近待总结内容；
  - 预算 = `min(target.maxOutput > 0 ? maxOutput : 8192, 32_000)`，废除 2048→8192 提额链；思考模式仍跟随会话；
  - 决策链：首轮非空但无模板小节 → **追问请求**（原消息 + reminder，不带首轮输出，opencode 同款；结果**宽松收下**）；任何请求正文完全为空 → `stripThinkTags(reasoning)` 末位兜底；瞬态错误且无产出 → 800ms 同请求重发；`retryable=false`（auth/invalid）与 `finish=length` 不重烧；每请求 usage 各自入账；错误信息带 `finish=` 诊断。
  - **两处有意宽于 opencode**：追问后不合规模型不再判失败（格式服从性参差的端点宁要次优摘要）；空正文保留 reasoning 兜底（真·只吐思考流的端点留活路）。
- 分块顺序摘要、previousSummary 逐块合并流式回调、run 级熔断、触发线/窗口、checkpoint 结构全部不动。

## 验证

- core 101 测试全绿（新增 6：`hasSummarySection` 精确命中/变形书写拒/散文空文拒；指令含全部派生标题自洽锁、`<既有摘要>` 内联合并句、reminder 文案）；`pnpm -w typecheck`、`pnpm -r test`、`electron-vite build` 全过。
- 文档：`docs/dev/agent-loop.md` §5.3 重写为 opencode 规则清单（含两处有意分歧的注明）。

## 用户验收

- agnes 系（vLLM 上游）手动压缩不再报 `No user query found in messages`。
- qwen3.8-flash 压缩：占位块一次性流式出带 `##` 小节的完整结构化摘要；不再"流一会儿出错"（若仍出现错误，消息会携带 `finish=`/追问诊断，方便定位是预算还是风控）。
- 右侧"累计"含摘要请求消耗（多 chunk/追问逐请求入账）。

## 遗留

- opencode 的严格语义（两轮均不合规模板 = 压缩失败宁缺毋滥）有意未照搬；若宽松版仍频繁产出低质摘要再收紧扣子。
- 空闲预压缩、压缩模型失败→会话模型降级链、`context_overflow` 文案带阈值提示等沿用 046 候选清单。
