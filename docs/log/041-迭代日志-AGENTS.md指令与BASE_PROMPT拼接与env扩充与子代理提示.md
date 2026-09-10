# 041 · AGENTS.md 项目指令 + BASE_PROMPT 常量拼接 + env 扩充 + 子代理专用提示

日期：2026-09-10
前置：040 P0 冒烟通过后进入 P1。调研发现 `ConfigStore.read()`（config/file.ts）会把 agents 数组整体持久化——直接改 `BUILD_AGENT.systemPrompt` 对老用户不生效（旧提示词固化在 config.json），故 systemPrompt 丰富化采用**代码常量拼接**而非迁移持久化（用户拍板）。

## 决策（用户拍板）

- systemPrompt 组装改为 `BASE_PROMPT`（代码常量，随版本演进免迁移）+ `agent.systemPrompt`（用户可编辑）双段拼接；P1 四项一批完成。
- 项目指令仅识别会话 cwd 下 `AGENTS.md`（不兼容 CLAUDE.md/.cursorrules，需要时后加）。
- 子代理用 `composeSystemPrompt(agent) + SUB_AGENT_ADDENDUM`，保留 agent 个性（task 可派 plan）。

## 变更

- **`core/src/instructions.ts`（新增）**：`loadProjectInstructions(cwd, cache)` 读 AGENTS.md（trim、截 10k 字符带提示），实例级 mtime+size 缓存，缺失/空返回空串；`renderProjectInstructions()` 渲染 `<project_instructions>` 段（空指令不产生空标签），内含"优先级高于一般行为约定"说明。
- **`core/src/settings-defaults.ts`**：新增 `BASE_PROMPT`（五节中文行为规范：执行风格/工具使用策略/代码约定/主动性/代码引用与验证；末行声明与 Plan 只读约束冲突时以只读为准）+ `composeSystemPrompt(agent)` + `SUB_AGENT_ADDENDUM`（子代理：自包含最终报告、不向用户提问、合理假设注明）。
- **`core/src/node/session-manager.ts`**：
  - `buildEnvBlock` 扩充：`操作系统` 行（os.type/release/arch）、`Git 仓库：是（分支 X）` 行（`git branch --show-current`，execFile 3s 超时，cwd 级缓存，失败静默视为非仓库）、`<project_instructions>` 注入段（`instructionsCache` 实例字段）。
  - system prompt 接入 `composeSystemPrompt`：estimateContext、runLoop 三处调用点、runSubAgent（后者追加 SUB_AGENT_ADDENDUM）。
- **文档**：`docs/dev/agent-loop.md` §3 更新（BASE_PROMPT/env 扩充/子代理段/AGENTS.md 语义）。

## 验证

- `pnpm -r typecheck` ✅ · `pnpm -r test` ✅ core 73/73（新增 `test/instructions.test.ts` 9 例：读取/缺失/空文件/截断/缓存命中与 mtime 失效/渲染/compose 拼接/子代理附加段）。
- **冒烟清单**（system prompt 不落库不显示 UI，靠行为观察 + 让模型复述）：
  1. **env 扩充**：git 仓库内开会话，让模型"逐字复述 system 提示中 `<env>` 到 `</env>` 之间的内容" → 应含 `操作系统：Linux x.x.x (x64)` 与 `Git 仓库：是（分支 xxx）` 行；非 git 目录对照 → 无 Git 行。
  2. **AGENTS.md（含热生效）**：cwd 放 `AGENTS.md` 写强可验证约定（如"回答首行必须是【已读 AGENTS.md】"）→ 对话遵循；修改内容后再发消息即生效（mtime 缓存失效，无需重启）；删除后恢复正常。
  3. **BASE_PROMPT 行为风格**（概率性改善，轻微信号不算失败）：要求"用 bash 读 package.json" → 应改用 read 工具；问"xx 功能在哪实现" → `文件路径:行号` 格式引用；改完代码即停不附加长总结，有 typecheck 脚本时主动跑。
  4. **子代理附加段**：让主会话 task 派遣只读调研子任务 → 返回自包含报告（结论/关键文件/未尽事项），中途不弹 question。
  - 观察点：上下文仪表基线较 P0 略高（BASE_PROMPT + env 两行 + instructions）属正常。
