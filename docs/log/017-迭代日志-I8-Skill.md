# 017 · 迭代日志 — I8 Skill 技能系统

> 日期：2026-09-04
> 状态：✅ 完成（构建/测试/Electron 冒烟通过）
> 对应：`docs/log/000-开发计划总览.md` → P2 skill（决策 20，设计文档 `docs/dev/skills-and-mcp.md` §1）
> 背景：I7 脚本编排已真机验收通过（无问题）

## 目标

opencode 兼容的技能系统：目录即配置（SKILL.md），system prompt 注入可用技能列表，`skill` 工具按需加载正文并激活 allowed-tools 约束。

## 完成项

### 1. 三层发现（`core/src/skills/discovery.ts`）
- [x] 层级与优先级：**工作区** `<cwd>/.czagent/skills/` > **全局** `~/.czagent/skills/` > **内置**（打包资源，主进程注入 `builtinSkillsDir`）；同名高层覆盖低层
- [x] 轻量 frontmatter 解析（不引 YAML 依赖）：顶层标量、一级嵌套（`metadata:`）、内联数组、破折号列表；无法识别的行跳过（容错）
- [x] `SkillMeta { name, description, path, dir, source, allowedTools?, body }`；目录不存在/缺 SKILL.md 静默跳过
- [x] `scanSkills(cwd, builtinDir?, globalDir?)`（globalDir 参数便于测试注入）

### 2. 运行链路（SessionManager）
- [x] **system prompt 注入**：每次 runLoop 扫描一次，有技能时 envBlock 追加 `<available_skills>`（名称+描述+加载指引）；无技能不注入
- [x] **`skill` 工具**（`core/src/tools/skill.ts`）：`{name}` → 扫描 → 正文作为 tool-result 注入（**仅正文，不限制工具**——与 opencode 行为一致）
- [x] 内置资源目录：desktop 注入 `resources/skills`（打包 P3 配 extraResources）

### 2.1 变更：移除 allowed-tools（用户决策）
- **核实**：opencode 1.18.19 源码（`skill/index.ts` 的 `isSkillFrontmatter`）只识别 `name` + `description`，**完全没有 allowed-tools 处理**——它是 Anthropic Claude（Agent Skills）的约定，非 opencode 兼容
- **决策**：`allowed-tools` 用处不大且非兼容要求 → 移除（SkillMeta.allowedTools、ToolContext.activateSkill、runLoop 强制过滤与释放逻辑全部删除；frontend-design 的该字段一并删除）
- **最终语义**：技能 = "system 注入列表 + skill 工具按需加载正文"，加载后 agent 使用全量工具（与 opencode 一致）

### 3. 内置示例技能
- [x] **frontend-design**（Anthropic 官方开源技能）：正文与 frontmatter 原样收录（含 license 字段），头部注释来源（`anthropics/skills@main`），兼作真机测试用例

### 4. 接入
- [x] registry 注册 `skill`（build 全量注入）；默认权限 `{skill: allow}`（迁移自动补齐）；plan agent tools/allow 加 `skill`
- [x] `ctx.tools.skill` 对脚本自动可用

## 实施中发现并修复
- **PowerShell 编码事故**：用 `Get-Content -Raw` + `.Replace()` + `Set-Content` 修改 settings-defaults.ts 导致全文件中文乱码、字符串未终止 → 用 Write 工具整文件重写恢复（教训：**中文文件一律用 Edit/Write 工具，不用 PowerShell 文本替换**）
- scratch 测试 makeCtx 未应用 overrides 导致示例误判 runner 缺陷（实际 runner 正确）——debug 测试证伪后修正测试

## 验证结果

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ core + desktop |
| `pnpm test` | ✅ core 142/142（+8 skills：解析 3、三层合并/优先级 2、skill 工具 2、家目录路径 1；+2 集成：注入与正文加载/无技能不注入）+ desktop 11/11 |
| `pnpm build` | ✅ main 317KB |
| `pnpm dev`（Electron） | ✅ 无渲染错误 |

## 边界与后续
- 技能内 `scripts/` 辅助脚本本轮不执行（可经 bash 调用）；无技能管理 UI（目录即配置）
- frontmatter 复杂 YAML 特性（锚点/多行字符串）不支持；`allowed-tools` 语义为覆盖式约束 ∪ 只读基础集
- 真机验收：内置 frontend-design 应出现在 `<available_skills>`；让 agent 做 UI 设计任务观察 skill 加载与工具受限
- 下一 P2 项：**MCP**（官方 SDK + stdio/HTTP + 权限接入）→ 多模态 → task/python
