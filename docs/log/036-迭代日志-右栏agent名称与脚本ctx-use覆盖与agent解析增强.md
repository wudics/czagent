# 035/036 · 右栏 agent 名称显示 + 脚本 ctx.use 覆盖 MCP/技能 + agent 按 name 解析（I19）

- 日期：2026-09-09
- 关联：`035`（I18 ctx 增强）、`024`（工具矩阵）、`013/025`（MCP 三态）

## 背景 / 问题

1. **右栏 agent 显示原始 ID**：自定义 agent 的 id 是自动生成的（`agent-xxxx`），右侧信息面板直接渲染 `session.agentId`，选了「猛男村村长」却显示 `agent-mtr0i75y-hjrf`；顶部下拉框正确显示 name，两处不一致。
2. **脚本无法覆盖 MCP/技能范围**：
   - `ctx.agent.run` 的 `mcpServers` 只能与 agent 生效名单取交集（只能缩小、不能强制开启被排除/关闭的服务器）；
   - 脚本自身 `ctx.tools.*` 直调的 MCP 工具与技能范围在运行开始时按会话 agent 设置固定，运行中无法调整；
   - `skill` 工具只按全局 `disabledSkills` + agent `skillOverrides` 过滤，脚本没有任何覆盖入口。
3. **`ctx.agent.run({agent})` 只认 id**：自定义 agent 要填 `agent-mtr0i75y-hjrf` 这类生成 id，对脚本作者极不友好；且匹配不到时**静默回退 build**，拼写错误不可见。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 右栏同时显示 name + id（name 为主、id 小号弱化） | 脚本 `ctx.agent.run` 的 agent 参数现在 id/name 都可填，两处都可见便于对照引用；agent 删除后只剩 id 也能对上 |
| 2 | `mcpServers` 改**权威覆盖**：传入即按脚本名单（仅限 mcp.json 已配置的，未知名忽略），不再与 agent 名单交集 | 用户明确选择；脚本是用户本人编写的，"传了就按我的来"符合直觉；MCP 本就是懒连接+全局连接缓存，强制开启只是把它加进本次生效名单，不会重复 spawn |
| 3 | 新增 `ctx.use({ mcpServers?, skills? })`：作用于脚本自身后续 `ctx.tools.*` 直调 | 覆盖范围"两者都要"；与 `ctx.agent.run` 的 opts（子代理级）形成两层；只影响本次脚本运行，不落盘 |
| 4 | 新增 `skills` 白名单（agent.run opts + ctx.use）：权威覆盖 `disabledSkills`/`skillOverrides` | 技能只是加载文档正文，风险低，权威白名单语义简单；有值时 skill 工具只认名单内技能 |
| 5 | `ctx.use` 字段语义：缺省=不修改、`null`=清除覆盖、数组（含空数组）=权威名单 | 空数组"全关"与 null"回到设置"是两个不同需求，都要能表达 |
| 6 | agent 解析：id 精确 → name 精确 → 显式传入找不到**抛错**（错误列出全部 `name(id)`）；缺省/空 = build | 用户明确选择抛错；错误信息含可用列表，模型经 task 工具传错时也能自纠 |
| 7 | MCP 工具定义按需懒加载：`ctx.use` 名单内的服务器首次被调用时才 `getTools` 建立连接 | 避免设置覆盖时预连接全部服务器；复用 `McpRegistry` 连接缓存 |
| 8 | `task` 工具路径复用同一 `runSubAgent`/`resolveAgentRef`，不单独兼容 | 主会话模型传错 agent 时收到含可用列表的错误，可自行纠正，优于静默回退 |

## 实现

### 右栏（desktop）
- `RightPanel.tsx`：从 settings store 取 `agents`，按 id 反查 name 显示，id 以小号弱化文本跟随；`capitalize` 移除。

### 脚本 ctx（core）
- `script/types.ts`：
  - `ScriptAgentRunOptions.mcpServers` 语义改为权威覆盖；新增 `skills?: string[]`；`agent` 注释更新（id 或 name）；
  - 新增 `ScriptUseOverrides`（`mcpServers?/skills?: string[] | null`）；`ChildRunHandlers` 新增 `onUse(patch)`。
- `script/child.ts`：PRELUDE `__ctx` 新增 `use(patch)`（走 `__call` 帧）；主进程侧 dispatch 新增 `t === 'use'` 分支 → `handlers.onUse`。
- `tools/types.ts`：`ToolContext` 新增可选 `allowedSkills?: string[]`。
- `tools/skill.ts`：`allowedSkills` 有值 → 只保留名单内技能（权威覆盖）；缺省 → 原全局 `disabledSkills` 过滤。
- `mcp/registry.ts`：导出 `mcpServerPrefix(server)`（`mcp_<sanitize(server)>_`），供脚本侧按工具 id 前缀归属服务器。
- `node/session-manager.ts`：
  - 新增导出 `resolveAgentRef(agents, ref)`：id → name → 抛错（列出 `name(id)`）；缺省/空 = build；`runSubAgent` 与主循环 `task` 路径统一走它；
  - `runSubAgent`：`mcpServers` 显式传入时按 `loadMcpConfig` 的已配置名单过滤（权威化）；`agentOpts.skills` 透传为子代理工具执行 ctx 的 `allowedSkills`；
  - `runScriptSession`：`mcpDefById` 改为可增 Map + `loadMcpDefs(servers)`（预载 agent 名单）；`onTool` 对 `mcp_*` 调用按 `useMcpServers` 门控（名单外抛错、名单内未载则懒加载）；`useSkills` 透传 `runScriptTool` → `allowedSkills`；`onUse` 更新两个覆盖变量（`in` 判定 + `Array.isArray` 区分数组/null）。

## 兼容性

- `mcpServers` 从"交集"变"权威覆盖"是**行为变更**：此前"传了但 agent 排除 → 实际不带"的脚本，现在会真的开启该服务器。035 刚发布该参数，影响面可忽略。
- `agent` 匹配不到从静默回退变抛错：依赖旧行为的脚本（拼错 id 靠回退跑 build）会开始报错——错误信息即修复指引。

## 验证

- `pnpm -r typecheck` ✅；`pnpm --filter @czagent/core test` ✅（47：新增 `resolveAgentRef` 3 例、`skillTool allowedSkills` 1 例；`runEntryChild` e2e 扩展 ctx.use 三连调用透传断言）。
- 待 Electron 冒烟：①右栏 name+id 显示；②脚本 `ctx.use({mcpServers:['xx']})` 后直调 `mcp_xx_*` 成功、名单外被拒；③`ctx.agent.run({agent:'中文name'})` 命中、传错抛错并列出可用项；④子代理 `skills` 白名单覆盖全局禁用技能。

## 相关文件

- `packages/desktop/src/renderer/src/components/layout/RightPanel.tsx`
- `packages/core/src/script/{types,child}.ts`
- `packages/core/src/tools/{types,skill}.ts`
- `packages/core/src/mcp/registry.ts`
- `packages/core/src/node/session-manager.ts`
- `packages/core/test/script-ctx.test.ts`
- `docs/tut/脚本编写指南.md`（§5/§6.1/§6.2/§6.3 新增/§7.2/§7.3/§15）
