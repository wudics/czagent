# 027 · B — question 提问工具（模型向用户澄清）

日期：2026-09-06
前置：用户提出"是否有 questions 工具"；拍板：形态=可选多选+自由输入，命名 question、主会话 agent 可用，顺序 A(I14)→B。

## 目标
模型侧新增内置工具 `question`：调用 → 当前轮暂停 → 会话浮层弹出问题（选项按钮 + 自由输入兜底）→ 用户作答 → 回答以 tool-result 返回模型，循环继续。默认对"全开 agent"生效（矩阵默认 allow）。

## 实现

### core
- `provider.ts`：`QuestionRequest { id; question; options? }`；`SessionEvent` 增 `session.question`。
- `tools/types.ts`：`ToolContext` 增 `askUser?(q)`。
- 新 `tools/question.ts`：schema `question`(必填)+`options?`；execute → `ctx.askUser(...)`，返回 `answer.trim() || '<用户未回答>'`；无 askUser 返回 `''`。
- `session-manager.ts`：`pendingQuestions` map；`askUser()`（emit `session.question` 并等待；abort→''）；`resolveQuestion(id,answer)`（IPC）；三处工具执行上下文（runLoop / runSubAgent / 脚本 runScriptTool）注入 `askUser`；脚本 `ctx.tools` 排除 `question`（主会话专用）。
- 注册/策略：`tools/index.ts` 注册+导出；`policy.ts` `ALLOW_TOOLS` 加 question（默认 allow）、`TOOL_INVENTORY` 新分组 `interact`；index 导出。

### 桌面
- IPC `question.resolve`（preload/main → `mgr.resolveQuestion`）。
- `stores/questions.ts`：收集 `session.question` 待答（按会话隔离，仿 permissions store）。
- `components/chat/QuestionCard.tsx`：会话底部浮层（同 PermissionCard 定位 z-20）——问题文本、可选项按钮（点击即答）、自由输入框（Enter/保存按钮）、跳过；`ChatArea` 挂载。
- `main.tsx` attach questions 事件。
- i18n zh/en：`chat.questionTitle/questionInput/questionSkip`、`tools.labels.question`、`tools.sections.interact`；AgentsTab/PermissionsTab 分区数组补 `interact`。

## 测试（core 198，新增 3）
- `policy.test.ts`（+1）：question 默认 allow、入 TOOL_INVENTORY.interact、registry 已注册。
- `session-question.test.ts`（新 2）：模型 tool-call question → 等 `session.question` 事件并 `resolveQuestion('蓝')` → tool-result 含回答、会话继续完成；跳过（空回答）→ 返回「用户未回答」占位并继续。
- `tools.test.ts`：registry all 列表补 question。

## 验证
- typecheck ✅ · 测试 ✅（core 198 + desktop 11 = 209）· build ✅ · Electron 冒烟 ✅（无渲染错误）。

## 边界与后续
- question 调用占并发槽位直至作答或 stop（abort→'用户未回答'），与 permission 暂停模型一致；不弹权限卡（默认 allow）。
- Mock/脚本 ctx 不暴露 question（主会话 agent 专用）。
- 下一步：I15 多模态/模型适配层；python/task（可选）；P3。
