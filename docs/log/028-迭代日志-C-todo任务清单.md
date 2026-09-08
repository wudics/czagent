# 028 · C — todo 任务清单（单工具 + UI 面板）

日期：2026-09-06
前置：用户问"是否实现 todowrite" → 拍板：要 opencode 风格、单工具 `todo` + UI 面板、会话内存、聊天区折叠条。

## 目标
模型侧新增内置工具 `todo`：建清单 / 整体替换 / 按 1 基下标标状态；会话内跨轮保持；聊天区底部可折叠「任务清单」面板实时展示。

## 实现

### core
- `provider.ts`：`TodoItem { text; status }`；`SessionEvent` 增 `session.todo { todos }`。
- `tools/types.ts` `ToolContext` 增 `todo?(input): Promise<string>`。
- 新 `tools/todo.ts`：`TodoInput { todos?; statuses? }`；纯 `applyTodo`（整体替换/去重/上限30/标状态）；`todoToText`（`1. [status] text`）；`todoTool`（schema：可选 todos、statuses，1 基下标）。
- `session-manager.ts`：`todos = Map<sessionId,TodoItem[]>`（会话内存）；`getSessionTodo`（IPC）、`updateSessionTodo`（apply→set→emit session.todo→返回文本）；三处工具执行 ctx 注入 `todo`（脚本 ctx 也可用）。
- 注册+导出；`policy.ts` ALLOW_TOOLS 加 `todo`（默认 allow）、inventory 放 `plan` 分区。

### 桌面
- IPC `todo:get`(sessionId) → items（preload/main）。
- `stores/todos.ts`：attach `session.todo` → 每会话 items；`load(sessionId)` 初始拉取。
- `components/chat/TodoStrip.tsx`：聊天区底部可折叠条（有清单才显示）——标题「任务清单 done/total」，展开显示每项状态点（灰/蓝/绿）+ 完成划线 + ✓；ChatArea 挂载。
- i18n zh/en：`chat.todoTitle/todoExpand/todoCollapse`、`tools.labels.todo`。

## 测试（core 200，新增 2）
- `session-todo.test.ts`：建清单(3)→statuses {1:in_progress,2:completed}→读：`getSessionTodo` 反映最新、`session.todo` 事件≥3、tool-result 历史含 `[completed] 补测试`；跨第二次 send 保持。空清单读取 → 占位文本。
- `policy.test.ts`/`tools.test.ts`：todo 默认 allow、inventory(plan)、registry 注册、all 列表含 todo。

## 验证
- typecheck ✅ · 测试 ✅（core 200 + desktop 11 = 211）· build ✅ · Electron 冒烟 ✅。

## 真机反馈调整（I28.1）
- 聊天区底部折叠条位置不妥 → **任务清单移至右侧面板**（RightPanel，「会话信息」区下方，`border-t` 分隔区块）：标题「任务清单 done/total」+ 状态点列表（灰/蓝/绿，完成划线）；**常驻显示**，空时「暂无任务（模型使用 todo 工具后显示）」。
- 删除 `TodoStrip.tsx` 与 ChatArea 挂载；`activeId` 切换时 `todos.load(sessionId)` 初始拉取 + `session.todo` 事件实时刷新（store/IPC 复用不变）。
- i18n：新增 `panel.todoTitle/todoEmpty`，移除 `chat.todoTitle/todoExpand/todoCollapse`（zh/en）。
- 验证：typecheck ✅ · 测试 ✅（core 200 + desktop 11 = 211）· build ✅ · 冒烟 ✅。

## 真机反馈修复（I28.2）
症状：① 完成一轮任务后模型反复重发/重执行 todo；② 右栏状态不对、缺明确状态提示。
根因（同一处）：`applyTodo` 在传 `todos` 时把所有项重置为 pending，而工具描述又要求"每次带上完整 todos" → 模型每步重发全量清单，已完成项状态被抹掉 → 面板状态错 + 模型误以为未完成而重做。
修复：
- `applyTodo` **按文本保留状态**：重发 todos 时同文本项沿用旧 status（新项才 pending），显式 `statuses` 覆盖——重发清单变为安全自愈操作。
- 工具描述重写：开始时传一次 todos 建清单；**之后只用 statuses 推进**（1 基下标），清单内容真变化才重发 todos；无变化不再调用、completed 项勿重做。
- 写操作（含 todos/statuses 的调用）结果末尾附一行 `TODO_HINT`（"更新状态只传 statuses，勿重发整份 todos；已 completed 勿重做"）；**纯读取不加**。
- RightPanel 状态指示（无文字方案，用户确认）：completed=绿色 ✓ 图标+文本 muted（**去掉划线**，✓ 与划线语义重复且划线不美观）；in_progress=**脉动蓝点**（animate-pulse，深色主题下与灰点强区分）；pending=灰点。
- 测试：applyTodo 状态保留单测（重发保留/新项 pending/statuses 覆盖）；写操作结果含提示行、读操作不含；原回归全绿。
- 验证：typecheck ✅ · 测试 ✅（core 201 + desktop 11 = 212）· build ✅ · 冒烟 ✅。

## 边界与后续
- todo 仅会话内存（重启清空，用户已确认）。
- 脚本 ctx.tools.todo 也可用（同一会话清单）。
- 下一步：I15 多模态/模型适配层；python/task（可选）；P3。
