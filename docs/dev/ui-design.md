# 界面设计

> 对应 PLAN.md 决策 #14、#15、#22、#23、#25。目标：I1 起即可浏览器直跑全部交互（mock），核心完成后无缝切换真数据。

## 1. 布局（三栏）

```
┌────────────┬─────────────────────────────┬──────────────┐
│ 会话栏       │  对话区                       │ 右侧面板(可折叠)│
│            │                             │              │
│  ○ 新建会话   │  消息流（虚拟滚动）            │ 会话信息      │
│  ├ 会话A ●运行│  [用户消息]                  │  · 模式/模型   │
│  ├ 会话B (排) │  [assistant: reasoning 内联]│  · cwd        │
│  ├ 会话C     │  [tool-call 卡片]           │  · token/cost │
│  │ ...       │  [assistant: 正文]          │  运行日志      │
│  └ 设置      │                             │              │
│            │  ───────────────────────────  │              │
│            │  [输入框] 思考模式·模型·附件·发送 │              │
└────────────┴─────────────────────────────┴──────────────┘
```

- 会话栏：列表 + 运行中/排队徽标 + 模式标识（chat/script）+ 新建会话（选 cwd、模式、模型、思考模式）。
- 设置入口：侧栏底部或顶栏齿轮 → 设置页（§6）。

## 2. 会话切换体验（决策 14 的一部分）

- 切换到某会话：立即展示**最新**内容，滚动条**在底部**。
- 向上滚动到顶部附近：加载更早一页历史（`messages:page` beforeId 锚点），加载时"钉住"当前滚动位置。
- 向下滚动离开已加载区：释放早期页（内存恒定）。
- 底部"**一键到底**"浮动按钮：`scrollToIndex(last)`。

## 3. 虚拟滚动 + 自动滚动（决策 14）

- **@tanstack/react-virtual**：动态高度测量（markdown 渲染后高度变化大），窗口只挂载可见项 + overscan 10。
- **反向分页**（ChatArea + chat store）：
  - **上拉预载**：触发条件 `首个可见概念索引 − droppedCount ≤ 4`（按距占位区边界的真实消息数计算，非概念索引——否则下拉销毁产生的占位区要一路滚穿才触发）。
  - **下拉销毁（内存窗口）**：只删渲染窗口（含 overscan 缓冲 12）之外的最旧消息，可见内容永不被销毁；删除前按 `measurementsCache` 实测高度累加 `(实测 − 96 估算)` 差值并同步回退 scrollTop——**视口零跳动**；被删区滚上去显示"正在加载历史…"占位，靠近即自动重载（无缝衔接）。
  - `loadMoreTop` 函数式更新（消除与销毁的快照竞态）；加载后按 `lastTopShift` 位移锚定滚动位置。
- **自动滚动（意图驱动跟随，对齐 opencode 时间线）**：
  - 新消息/流式输出时，若用户处于跟随态（钉底）→ 自动跟随（rAF 合并布局变化）。
  - **解钉看方向不看距离**：任一来源的上移（滚轮 deltaY<0、拖拽滚动条、键盘上向键、触屏下拉）立即解钉——纯距离阈值在"底部 150px 内慢滚阅读"时会被每帧拉回，形成拉锯竞态；近底且下移才恢复吸附（"接近底部"= 重新跟随意图）。程序性位移豁免（预载锚定回跳、dropOldest 补偿同步更新基线，不误判为上滚意图）。
  - **卡内滚动区（`data-scrollable`：工具结果 pre、思考正文）豁免滚轮解钉**——区内滚动是阅读内容，不是浏览历史意图。
  - 进入会话有强制钉底阶段（轮询至高度稳定）；会话切换重置全部游标。
  - 点击"一键到底"恢复跟随并清零计数；解钉期间新到达消息数在按钮上显示徽标（N 条新内容）。

## 4. 消息渲染（决策 22 + 决策 15）

- **markdown（Web Worker 管线）**：`marked`（gfm+breaks）在 Worker 内解析，**块级增量渲染**——`marked.lexer` 切顶层块逐块解析，块源串哈希为键 LRU 缓存（800 块），流式期间已完成前缀块全命中、只重解析尾部块（整条流成本 O(尾部块) 而非 O(全文)）；文本级缓存（useMarkdown，300 条真 LRU）+ 60ms 防抖合并高频更新。**DOMPurify 消毒**在主线程响应处做一次并缓存（USE_PROFILES html，禁 style/script/iframe/form 等）；解析失败回退转义纯文本，杜绝 HTML 注入。>10k 字符降级有界纯文本块（LongText 折叠展开）。
- **reasoning 内联（决策 15 · 修订：完成自动折叠）**：`reasoning` part 与正文**同一消息内连续渲染**，视觉区分（灰调 + 斜体 + 淡背景），不拆成独立消息；**流式中自动展开**实时滚动（有界 max-h 56 + `data-scrollable` 防布局跳与误触解钉）；结束（首个正文/工具 delta 或流终点）自动**折叠为一行「已思考 · Ns」**。part 落库 `time?: {start, end}`（start=首个思考 delta，end=首个非思考产物/流结束）——历史消息同样按完成态渲染、无 time 不显示时长；用户手动开合过则不再自动折叠。
- **工具合并卡（对齐 opencode BasicTool）**：tool-call 与其 tool-result **按 callID 配对为一张折叠卡**（MessageItem `toRenderItems` 预配对；孤儿 result 单独兜底渲染）。状态机 **pending → running → completed/error**：pending=流式中参数未齐（`tool-call-start` 即建卡，模型一开始发工具调用就立即可见）；running=参数齐/执行中（spinner）；`reportProgress` 可实时更新卡片标题。标题行=工具名 + 入参摘要（紧凑 JSON ≤90 字）/进度标题 + 状态徽标；展开区=参数 + 结果正文（均有界滚动、`data-scrollable`）。执行中默认展开 → 完成/失败**自动折叠成一行**（尊重用户手动开合）；历史消息挂载即完成态默认折叠——长工具会话大幅减 DOM 与视觉噪音。
- **附件/富输出**：文件引用 part 显示文件名/类型，点击在资源管理器中显示；生成的图片/视频/音频内联渲染。
- **压缩 checkpoint**：`compaction` part（user 角色系统消息，全宽渲染不走气泡）：压缩中为"正在生成摘要…"spinner + **流式摘要自动展开实时可见**；完成后原地变"历史已压缩 · 点击展开摘要"折叠条（显示位置=压缩完成时刻，随新对话自然上移）。
- **状态条 StatusBanner**（聊天区底部浮动，仅瞬态出现）：循环级重试等待（原因 + 第 x/N 次）；运行中自动压缩提示。
- **权限请求**：弹窗卡片（工具、参数、目标路径、三选一按钮）；plan-exit 内嵌计划预览。
- **跨会话压缩追踪**：`compactingBySession` 注册表在事件守卫前更新，切换会话不丢压缩状态；切回时按占位块 id 重建继续流式（错过的 delta 携带全量累积文本自动追上）。

## 5. 输入框

- 文本输入（Enter 发送 / Shift+Enter 换行）+ 发送与**停止**按钮（运行中切换为停止）。
- **思考模式切换**（决策 15）：下拉三档 关闭 / 思考 / 深度思考（跟随会话级设置，可临时改）。
- **模型下拉**：当前会话 chat 模型，可切换；显示值按解析回退链 `resolveChatModelId`（settings store）：会话自身 modelId（有效时）→ chat 能力绑定 → 第一个启用对话模型 → 无任何模型显示「未配置」；**不再渲染"已删除的模型"占位**（I 迭代 039）。打开会话时悬空 modelId 按回退链自动 patch 落库（chatStore.open），主循环随之直接解析成功；未配置模型时不改数据。侧栏/右栏的 `ModelName` 组件与绑定区下拉同样走该回退链。
- **附件按钮**：打开文件选择器 → `uploadAttachment`（限制大小，见 attachments.md）。
- 附加：发送后清空、enter 聚焦、草稿保存（切换会话保留输入）。

## 6. 设置页（I2）

| 区块 | 内容 |
|---|---|
| 模型 | 三区管理（2026-09 重构，I 迭代 037）：**对话模型**（每条自带接口实现 implId 下拉/baseUrl/apiKey/模型名/上下文与输出上限/toolcall/vision/参数 options，添加时预填默认地址并复用同实现 Key，保存不自动设默认）、**多模态模型**（按 capability 绑定单模型：embedding/rerank/图像/视频/语音/图像理解，实现各有针对性下拉）、**能力绑定**（8 个 capability → 模型 id，下拉按能力过滤候选，用户手动设置默认；写 config.json `chatModels`/`multimodalModels`/`bindings`） |
| Agent | build/plan 系统提示词编辑、新建自定义 agent（提示词 + tools + permission + steps + model） |
| 权限 | 全局默认规则、危险操作默认策略、websearch 引擎开关与 AI 检索 API Key（P2/048） |
| 通用 | 语言（中文/英文）、并发上限、压缩阈值、主题（浅/深/跟随系统） |

## 7. 状态管理（zustand）

- `sessionsStore`：会话列表 + 状态（idle/running/queued）+ 排序。
- `chatStore(sessionId)`：已加载消息页、是否到底、自动滚动开关、输入框状态。
- `settingsStore`：模型目录合并结果、agent 定义、权限规则；派生方法 `chatModels()/modelById()/bindingOptions()/resolveChatModelId()`（返回新建数组的方法仅供命令式调用，hook 中须 selector 选 `settings` 后 useMemo 派生，防 useSyncExternalStore snapshot 不稳定）。
- 事件分流：`onEvent` 回调按 `ev.sessionId` 分发到对应 store；运行中会话的 token/cost 实时更新页脚。

## 8. Mock 模式（决策 25，I1 核心）

- 入口：`pnpm dev:ui`（Vite 独立运行 renderer，`import.meta.env.DEV + VITE_MOCK=1` 注入 MockProvider）。
- MockProvider 内建数据：初始会话若干、历史消息生成器（可生成上千条用于分页/释放演示）。
- **模拟流式**：内置 4 个演示脚本，按脚本逐 token 发射 `SessionEvent`：
  1. 普通流式回复（markdown 长文，演示滚动跟随）
  2. 带 reasoning 的回复（思考→正文衔接、内联样式）
  3. 工具调用流程（tool-call 卡片 → tool-result → 继续正文）
  4. 错误回复（error 样式）
- 交互控件照常可用：会话新建/切换、滚动、分页、自动滚动、一键到底、思考模式切换、模型下拉、附件占位、停止按钮。
- 用户在浏览器即可"玩"全部 UI 交互并给反馈，I3 接入真数据后无感知切换。

## 9. i18n（决策 23）

- i18next / react-i18next，默认中文，语言切换在设置页；文案集中 `locales/zh-CN.json` / `en-US.json`。
- agent/system prompt 文案（build/plan 等）可参考 `docs/ref/opencode-prompt-cn/` 中文版，同样做 i18n。
