# Skill 与 MCP（P2）

> 对应 PLAN.md 决策 #19、#20。两个都是 P2 阶段功能，P1 预留接口。

## 1. Skill（决策 20：opencode 兼容格式）

### 1.1 格式

```
<cwd>/.czagent/skills/
└── my-skill/
    ├── SKILL.md          # 入口
    ├── resources/        # 参考资源（可选）
    └── scripts/          # 辅助脚本（可选，可执行）
```

`SKILL.md` frontmatter：

```md
---
name: my-skill
description: 当用户提到「XX」时使用该技能做 YYY
metadata:
  tools: [...]          # 技能可能用到的工具提示
  allowed-tools: [...]  # 执行时允许的工具白名单（可选）
---

# 使用说明
（正文：步骤、约束、如何与模型协作）
```

> 与 opencode 兼容（`docs/ref/opencode-1.18.19-src/.opencode/skills/customize-opencode` 为官方示例，中文版见 `docs/ref/opencode-prompt-cn/06-skill-prompts/`）。

### 1.2 发现

- 目录：全局 `~/.czagent/skills/` + 工作区 `<cwd>/.czagent/skills/`，递归扫描 `SKILL.md`。
- 读取 frontmatter 建立索引（name/description），随 cwd 切换刷新。

### 1.3 使用

- System prompt 注入 `<available_skills>` 列表（名称 + 描述），agent 按任务判断是否加载。
- `skill` 工具：`{ name }` → 读取 SKILL.md 正文注入上下文（reference 化），技能内允许调用的工具按 `allowed-tools` 约束。
- 卸载：每次回复后按规则释放技能上下文，避免污染后续对话。

## 2. MCP（决策 19：官方 SDK）

### 2.1 客户端

- 依赖：`@modelcontextprotocol/sdk`（TypeScript 官方）。
- 传输：**stdio**（本地 server：npx / python 启动）+ **HTTP/SSE**（远程 server）。
- 生命周期：server 启动/健康检查/工具列表拉取/错误隔离（单个 server 崩溃不影响会话）。

### 2.2 配置（JSON 配置文件）

```jsonc
// <cwd>/.czagent/mcp.json 或全局 ~/.czagent/mcp.json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "env": { "ALLOWED_DIRS": "." } },
    "remote-search": { "type": "http", "url": "https://example.com/mcp/sse" }
  }
}
```

### 2.3 工具接入

- MCP 暴露的 `tools` 经适配层包装为 `ToolDef` 注册进统一注册表（工具名加 server 前缀防冲突）。
- **权限约束**：执行时与本地工具同权——过权限系统（cwd 边界、ask 确认、deny 规则）。例如远程 MCP 的写操作需用户确认。
- 工具描述注入 `<mcp_instructions>` 到 system prompt（按会话权限过滤可见 server）。

### 2.4 与 websearch 的关系

- websearch（决策 17）独立于 MCP；MCP 搜索类 server 作为 P2 之后的可选增强（双通道时优先内置）。

## 3. P1 预留

- `core/src/skills/`、`core/src/mcp/` 目录存在，定义最小接口（`SkillProvider` / `McpRegistry`），P1 不实现。
- 配置 schema 预留 `mcp` 字段；system prompt 预留 skill 注入位。
