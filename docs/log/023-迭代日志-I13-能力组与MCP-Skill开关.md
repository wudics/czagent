# 023 · I13 — 能力组 + MCP/Skill 开关（agent 不记名、新进自动可用）

日期：2026-09-06
前置：I12；用户确认模型：丙·混合（配置分组 + 技能常驻 + MCP 按服务器开关为规模闸门）。

## 目标与决策（用户拍板）

- 痛点在**配置层**：agent 的 tools/allow 等要用精确 id、新 skill/MCP 进来不会自动生效。
- 交互模型：**丙·混合**——配置用能力组；技能文本常驻（廉价）；MCP 按"服务器开关"决定是否进 schema。
- 四项决策：技能全局关闭**存设置（settings.general.disabledSkills）**不碰文件；agent 的 MCP 表达用**每服务器 继承/强制开/排除**；工具组采用 **file/shell/web/media/skill**；权限规则升级（组名/通配 `mcp_*`）本轮做。

## 核心设计

配置里不再出现工具 id；agent 只表达 3 个选择，全部运行时实时展开：
1. **工具 = 能力组**（勾组）；`groups` 与 `tools` 皆空 = 全量（兼容旧 build `tools:[]`）
2. **MCP = 服务器三态**（偏离项 `agent.mcp`）；全开 agent 并入"全局 enabled 且非 off"；受限 agent 只并入点名 on 的服务器
3. **技能 = agent 开关 + 全局禁用名单**；关闭不进 `<available_skills>` 且 skill 工具拒绝加载

## 实现

### core
- `tools/groups.ts`（新，纯模块）：`TOOL_GROUPS`（file/shell/web/media/skill → 成员 id）+ `expandGroups` + `resolveAgentToolset`（空=全量）。经 index.ts 导出供桌面/权限用。
- `tools/registry.ts`：`resolve` 语义收敛为"接收已展开 id 集合（空=全部公开）"；新增 `publicToolIds()`。参数语义与原 `resolve(agentTools)` 一致，无破坏。
- `provider.ts`：`AgentDef` 增 `groups?: string[]`、`mcp?: Record<string,'on'|'off'>`、`skillsEnabled?: boolean`（全可选）；`GeneralSettings` 增 `disabledSkills?: string[]`。
- `mcp/config.ts`：`McpServerConfig` 增 `enabled?: boolean`；`isMcpServerEnabled()`（未设 false 即启用）；保留 disabled 条目供 UI 展示。注册表不预过滤——由运行期"生效名单"过滤。
- `mcp/registry.ts`：`getTools(cwd, globalDir?, servers?: string[])` 服务器 allow-list 过滤。
- `node/session-manager.ts`：
  - `isAgentAllOpen()` / `allowedMcpServers(cwd, agent)`（全开：全局 enabled∧非 off、on 覆盖；受限：仅 on）
  - runLoop 每轮工具组装：组展开 → registry.resolve；MCP 按 allowed 名单取工具
  - runSubAgent 与脚本 ctx（runScriptSession）同规则接入
  - `available_skills` 注入过滤 `disabledSkills` × `agent.skillsEnabled`
- `tools/skill.ts`：skill 工具按 `settings.general.disabledSkills` 过滤（agent 级开关在 env 层控制）。
- `permission/index.ts`：新增 `matchesRule(pattern, tool)`（`*`=全匹配、尾缀 `*`=前缀、组名=展开成员、否则精确），`checkPermission` 的 agent 列表与全局规则均接入。
- `settings-defaults.ts`：`DEFAULT_GENERAL.disabledSkills: []`。

### 桌面
- **AgentsTab**（重写）：能力组徽标点击勾选（含成员数）+ 空=全量徽标（"全量工具（新增自动并入）"）；非全量时"额外精确工具"输入；MCP 服务器行 继承/强制开/排除（服务器列表取自 `mcpGetLayers(活跃会话 cwd)`，实时）；技能注入 Switch；保留 name/model/描述/systemPrompt/allow-deny-ask/steps。
- **McpTab**：每行"启用"Switch——全局条目写 `enabled` 到全局 mcp.json（编辑表单提交时保留 enabled），工作区条目只读展示。
- **SkillsTab**：行内 Switch 改绑定 `settings.general.disabledSkills`（存设置并持久化；列表为内置+全局技能）。
- i18n zh/en：agents.groups.*、agents.allOpen/toolsHint/skills/mcp.*、skills.enabledHint/enabled/disabled、mcp.enabled*。

## 测试（新增 11 个，均含在 184 内）

- `groups.test.ts`（新 4）：组引用完整性（每个 id 已注册且非内部）、expandGroups 去重/未知组、resolveAgentToolset（空=全量/子集/叠加）、registry.resolve × 组展开（空=全部公开、publicToolIds 不含 plan-exit）。
- `permission.test.ts`（+2）：matchesRule（精确/组/通配/全匹配）；checkPermission 组规则与通配、agent allow 组。
- `mcp.test.ts`（+3）：受限 agent `mcp:{offB:'on'}` 强制并入全局关的 offB（且 file 组 base、不含 bash/onA）；全开 agent 仅并入 `enabled!==false` 的服务器；`getTools` servers 名单过滤。
- `session-manager.test.ts`（+2）：disabledSkills → 不注入 available_skills + skill 工具拒绝（报"未找到技能"、正文不出现）；agent `skillsEnabled:false` → 不注入。

## 验证

- typecheck ✅ · 测试 ✅（core 184 + desktop 11 = 195）· build ✅（main 358KB）· Electron 冒烟 ✅。
- 既有 build/plan agent 与旧精确-tools 自定义 agent 均向后兼容（字段全可选；空 groups+tools=全量语义不变）。

## 边界与后续

- 验收点：新增 skill/MCP 服务器后，默认 build agent **零改动**即可用；用户/agent 都不再需要写任何工具 id。
- 语义说明：受限 agent（选了组）不带 MCP，除非对某服务器点"强制开"；想"只对某服务器排除"用"排除"。
- I12 起你的真实 `serverfs`（现 args 已指向 `czworkspace`）在 build 下仍默认并入。
- 待办序列不变：I14（脚本目录入口直跑）→ I15（多模态适配层）；权限规则 UI 输入仍为文本（支持组名/通配，含内置标记与恢复默认）。
