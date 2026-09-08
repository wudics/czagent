# 021 · I11 — Skill / MCP 配置界面

日期：2026-09-05
前置：I10.2（多模态拆分）、I9（MCP）、I8（Skill）已完成。

## 目标

用户此前要求："后续分别加上 skill 和 mcp 配置界面再测试"。本轮实现设置页两个新 Tab，作为 MCP 真机验收的前置（不再手写 mcp.json）。

## 定稿决策（用户确认）

1. **MCP 配置范围**：设置页增删改仅作用于**全局层** `~/.czagent/mcp.json`（所有会话生效）；工作区层 `<cwd>/.czagent/mcp.json` 只读展示（来源标记 + 打开配置文件按钮），仍由文件维护（项目级、可 git 共享）。
2. **编辑交互**：新增/编辑共用同一个对话框表单（点条目"编辑"预填），非行内编辑。
3. **Skill 管理**：只读列表 + 打开目录（技能本质是文件目录，编辑在文件系统做）。

## 实现

### core
- `mcp/config.ts`：
  - `readMcpLayers(cwd, globalDir?)` → `{ entries: [{ name, config, source: 'global'|'workspace' }], globalPath, workspacePath }`，工作区同名覆盖全局（覆盖后来源标记为 global，条目只剩一份）；缺失/坏 JSON 该层为空。
  - `writeGlobalMcpConfig(config, globalDir?)`：写全局层（`mkdir -p` + JSON.stringify indent 2），工作区层不受影响。
- `mcp/registry.ts`：`testConnection(cfg)` —— **独立临时客户端**（不进缓存），stdio/HTTP(SSE 回退) 连接 → listTools → close，返回 `{ ok, tools(原始名), error }`；失败不污染缓存/冷却表。
- `session-manager.ts`：
  - 新选项 `globalMcpDir?`（默认 `~/.czagent`；**测试注入临时目录**，防止污染真实全局配置——本轮曾因此把测试数据写进真实 `~/.czagent/mcp.json`，已清理并加注入修复）。
  - `mcpGetLayers(cwd?)` / `mcpSaveGlobal(config)` / `mcpTest(cfg)` / `listSkills()`（builtin+global 两层，`scanSkills(homedir(), builtinDir)`，workspace 层路径与 global 重合无害去重）。
- `index.ts`：类型再导出 `McpConfig/McpServerConfig/McpLayerEntry/McpLayers/SkillMeta/SkillSource`（`export type`，浏览器入口无 node:fs 运行时依赖）。

### 桌面 IPC
- `shared/ipc.ts`：`mcp:getLayers / mcp:saveGlobal / mcp:test`、`skills:list`；`IpcApi` 增 `mcpGetLayers/mcpSaveGlobal/mcpTestConnection/listSkills`。
- `main/index.ts`：4 个 handler 直通 SessionManager。
- `preload/index.ts`：4 个方法暴露。

### 渲染层
- **McpTab**（设置 → MCP）：
  - 列表：名称 + 来源徽标（全局=蓝/工作区=紫）+ 命令或 URL 摘要；无活跃会话时仅全局层（提示）。
  - 全局条目：编辑（对话框预填）/删除（confirm）/测试连接；工作区条目：打开配置文件（openPath）。
  - 测试连接：按钮 → 结果行内显示"连接成功：N 个工具（列表）"或错误信息；testing 状态禁用。
  - 对话框表单：name（编辑时锁定）+ 类型切换（stdio/http）+ stdio: command、args（每行一个）、env（每行 KEY=VALUE）/ http: url、headers（每行 `Key: Value`）。
  - 保存逻辑：`saveGlobal` 只把 source==='global' 的条目写回全局层。
- **SkillsTab**（设置 → 技能）：三层只读列表（名称/描述/来源徽标/目录路径）+ 打开目录 + 刷新。
- **SettingsPage**：新增 `mcp`、`skills` 两个 Tab。
- i18n：`settings.mcp.*`、`settings.skills.*`、tabs 键（zh/en）。

## 测试（mcp.test.ts 12 个，含新增 5 个）

- `readMcpLayers`：来源标记 + 工作区覆盖语义（同名全局条目保留、来源为 global）；缺失/坏 JSON → entries 空。
- `writeGlobalMcpConfig` roundtrip（写→读回）。
- `SessionManager.mcpSaveGlobal + mcpGetLayers`（注入临时 globalMcpDir）。
- `testConnection`：stdio mock server → ok + 原始工具名（echo/ping，运行时才加 mcp_ 前缀）；不存在命令 → ok=false + error。

## 验证

- typecheck ✅ · 测试 ✅（core 173 + desktop 11 = 184）· build ✅（main 354KB）· Electron 冒烟 ✅（无渲染错误）。
- 真实 `~/.czagent/mcp.json` 已确认干净（测试期间曾短暂写入测试条目，已删除）。

## 真机反馈修复（I11.1）

- filesystem server 启动输出 "Client does not support MCP Roots" 属正常提示（Roots 是客户端告知 server 工作目录的机制；czagent 未实现，server 回退用 args 里的目录作为允许读写边界）——连接与工具发现不受影响
- [x] i18n：`common` 补 `cancel`/`save`（zh/en）——MCP 对话框"取消/保存"按钮此前缺键回退英文；grep 确认 common 仅引用 close/cancel/save 三个键，无其他缺失

## 边界与后续

- MCP 真机验收路径现已打通：设置页添加 server → 测试连接 → 会话中调用。
- 工作区层条目在会话运行时仍会合并生效（readMcpLayers 的覆盖语义与 I9 loadMcpConfig 一致）。
- 剩余 P2：task 子代理路由、python 执行器（可选）；P3：打包/自动更新/权限细化。
