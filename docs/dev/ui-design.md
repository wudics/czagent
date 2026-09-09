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

- **@tanstack/react-virtual**：动态高度测量（markdown 渲染后高度变化大），窗口只挂载可见项 + 上下 buffer（如 8 项）。
- **反向分页**：维护已加载消息数组，顶部到达 → 加载上一页并 `scrollToIndex(加载前首条)`。
- **自动滚动**：
  - 新消息/流式输出时，若距容器底部 < 阈值（150px）→ 自动跟随滚动。
  - 用户向上滚离阈值 → **暂停自动滚动**（判定为查看历史）。
  - 用户向下滚回阈值内 / 点击"一键到底" → **恢复自动滚动**。
- 实现：监听 `scrollTop/scrollHeight` 变化 + `isNearBottom()` 布尔，渲染侧用 effect 控制。

## 4. 消息渲染（决策 22 + 决策 15）

- **markdown**：react-markdown + remark-gfm + 代码高亮（shiki/highlight.js）+ 表格 + 折叠代码块；渲染放 **Web Worker**（输入原始 markdown → 输出 HTML），主线程 memo 缓存，避免长文档卡顿。
- **reasoning 内联**（决策 15）：`reasoning` part 与正文**同一消息内连续渲染**，视觉区分（灰调 + 斜体 + 淡背景 + "思考中"占位），不折叠、不拆成独立消息；流式时思考先出、正文随后自然衔接。
- **工具卡片**：tool-call part 渲染为卡片（工具名 + 参数摘要 + 展开/收起），下方承接 tool-result（输出摘要 / 错误红框 / 附件缩略）。状态：pending → running（spinner）→ completed/error。
- **附件**：文件引用 part 显示文件名/类型/大小，点击打开。
- **压缩 checkpoint**：`compaction` part 以折叠样式显示"历史已压缩摘要"，可展开。
- **权限请求**：弹窗卡片（工具、参数、目标路径、三选一按钮）。

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
| 权限 | 全局默认规则、危险操作默认策略、websearch 引擎开关（P2） |
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
