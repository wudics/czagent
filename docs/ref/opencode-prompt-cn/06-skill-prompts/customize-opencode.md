<!--
  内置技能。名称和描述在代码中注册于
  packages/opencode/src/skill/index.ts（参见 CUSTOMIZE_OPENCODE_SKILL_NAME
  和 CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION）。下面的正文成为
  该技能的内容。
-->

# 定制 opencode

opencode 严格验证自己的配置，当字段出错时拒绝启动。下面的结构覆盖了常见的表面区域，但它们是**总结，而不是权威来源**。

## 完整 schema 参考

每个配置选项的权威列表——包含字段类型、枚举、默认值和描述——位于已发布的 JSON Schema 中：

**<https://opencode.ai/config.json>**

如果某个字段没有在此技能中记录，或者你需要确认一个确切的结构后再写配置，**直接抓取该 URL 并阅读 schema**，而不是猜测。opencode 对无效配置会硬失败，所以错误结构的代价是启动失败。

此外，每个 `opencode.json` 都应该声明 `"$schema": "https://opencode.ai/config.json"`，这样用户的编辑器就能在输入时捕获错误。

## 应用改动

配置在 opencode 启动时加载一次，不会热重载。保存对 `opencode.json`、agent 文件、技能、插件或任何其他配置期文件的改动后，**告诉用户退出并重启 opencode** 以让改动生效。在此之前，正在运行的会话会继续使用已加载的配置。

## 文件的位置

| 作用域 | 路径 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 项目配置 | `./opencode.json`、`./opencode.jsonc` 或 `.opencode/opencode.json`（opencode 从 cwd 向上走到 worktree 根目录） |
| 全局配置 | `~/.config/opencode/opencode.json`（不是 `~/.opencode/`） |
| 项目 agents | `.opencode/agent/<name>.md` 或 `.opencode/agents/<name>.md` |
| 全局 agents | `~/.config/opencode/agent(s)/<name>.md` |
| 项目技能 | `.opencode/skill(s)/<name>/SKILL.md` |
| 全局技能 | `~/.config/opencode/skill(s)/<name>/SKILL.md` |
| 外部技能（自动加载） | `~/.claude/skills/<name>/SKILL.md`、`~/.agents/skills/<name>/SKILL.md` |

来自每个作用域的配置会被深度合并。项目覆盖全局。`opencode.json` 中未知的顶级键会被拒绝并抛出 `ConfigInvalidError`。

## opencode.json

每个字段都是可选的。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "username": "string",
  "model": "provider/model-id",
  "small_model": "provider/model-id",
  "default_agent": "agent-name",
  "shell": "/bin/zsh",
  "logLevel": "DEBUG" | "INFO" | "WARN" | "ERROR",
  "share": "manual" | "auto" | "disabled",
  "autoupdate": true | false | "notify",
  "snapshot": true,
  "instructions": ["AGENTS.md", "docs/style.md"],

  "skills": {
    "paths": [".opencode/skills", "/abs/path/to/skills"],
    "urls": ["https://example.com/.well-known/skills/"]
  },

  "agent": {
    "my-agent": {
      "model": "anthropic/claude-sonnet-4-6",
      "mode": "subagent",
      "description": "...",
      "permission": { "edit": "deny" }
    }
  },

  "command": {
    "deploy": { "description": "...", "prompt": "..." }
  },

  "provider": {
    "anthropic": { "options": { "apiKey": "..." } }
  },
  "disabled_providers": ["openai"],
  "enabled_providers": ["anthropic"],

  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "env": {}
    },
    "remote-thing": {
      "type": "remote",
      "url": "https://...",
      "headers": { "Authorization": "Bearer ..." }
    }
  },

  "plugin": [
    "opencode-gemini-auth",
    "opencode-foo@1.2.3",
    "./local-plugin.ts",
    ["opencode-bar", { "option": "value" }]
  ],

  "permission": {
    "edit": "deny",
    "bash": { "git *": "allow", "*": "ask" }
  },

  "formatter": false,
  "lsp": false,

  "experimental": {
    "primary_tools": ["edit"],
    "mcp_timeout": 30000
  },

  "tool_output": { "max_lines": 200, "max_bytes": 8192 },

  "compaction": { "auto": true, "tail_turns": 15 }
}
```

值得明确说明的结构要点：

- `model` 总是带 provider 前缀：`"anthropic/claude-sonnet-4-6"`。
- `skills` 是一个带 `paths` 和/或 `urls` 的对象，不是数组。
- `agent` 是以 agent 名为键的对象，不是数组。
- `plugin` 是字符串或 `[name, options]` 元组的数组，不是对象。
- `mcp[name].command` 是字符串数组，绝不应该是单个字符串。`type` 是必需的。
- `permission` 是字符串动作，或按工具名为键的对象。

## 技能

opencode 的技能加载器会在技能目录内扫描 `**/SKILL.md`。文件名必须精确为 `SKILL.md`，并且位于以技能名命名的自己的文件夹中：

```
.opencode/skills/my-skill/SKILL.md
```

Frontmatter：

```markdown
---
name: my-skill
description: 一句话，覆盖这个技能做什么以及何时触发它。前置加载用户可能说出的字面关键词或文件名。
---

# My Skill

（markdown 格式的技能正文：指令、示例、引用）
```

- `name` 是必需的，小写连字符分隔，最多 64 个字符，且与文件夹名匹配。
- `description` 实际上是必需的：没有描述的技能会被过滤掉，永远不会呈现给模型。同时覆盖技能*做什么*和*何时使用*。用第三人称写（"Use when..."，而不是 "I help with..."）。前置加载具体的触发关键词和文件名；如果技能应在相邻话题上保持安静，用 "Use ONLY when..." 来限定。
- 可选：`license`、`compatibility`、`metadata`（字符串-字符串映射）。

通过 `skills.paths`（递归扫描 `**/SKILL.md`）和 `skills.urls`（每个 URL 提供一份技能列表）从非默认位置注册技能。

## Agents

定义 agent 有两种方式。对于任何非平凡的内容，使用文件形式。

### 内联（在 `opencode.json` 中）

```json
{
  "agent": {
    "my-reviewer": {
      "description": "评审 PR 是否有风格违规。",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-6",
      "permission": { "edit": "deny", "bash": "ask" },
      "prompt": "你是一名严格的 PR 评审员..."
    }
  }
}
```

### 文件

```
.opencode/agent/my-reviewer.md      或     .opencode/agents/my-reviewer.md
```

```markdown
---
description: 评审 PR 是否有风格违规。
mode: subagent
model: anthropic/claude-sonnet-4-6
permission:
  edit: deny
  bash: ask
---

你是一名严格的 PR 评审员。专注于...
```

文件正文成为 agent 的 `prompt`。不要在 frontmatter 中也放 `prompt:`。

`mode` 是 `"primary"`、`"subagent"`、`"all"` 之一。

允许的顶级 frontmatter 字段：`name, model, variant, description, mode, hidden, color, steps, options, permission, disable, temperature, top_p`。任何未知字段会被静默路由到 `options`。

要禁用内置 agent：`agent: { build: { disable: true } }`，或在文件中使用 frontmatter `disable: true`。

`default_agent` 必须指向非隐藏、primary 模式的 agent。

### 内置 agents

opencode 附带 `build`、`plan`、`general`、`explore`。隐藏的内部 agents：`compaction`、`title`、`summary`。要覆盖内置 agent 的字段，在 `agent: { <name>: { ... } }` 中定义相同的键。

## 插件

`plugin:` 是一个数组。每个条目是以下之一：

```json
"plugin": [
  "opencode-gemini-auth",            // npm spec，latest
  "opencode-foo@1.2.3",              // npm spec，锁定版本
  "./local-plugin.ts",               // 文件路径，相对声明它的配置
  "file:///abs/path/plugin.js",      // file URL
  ["opencode-bar", { "key": "val" }] // 带选项的元组形式
]
```

自动发现的插件（无需配置条目）：`.opencode/plugin/` 或 `.opencode/plugins/` 中的任何 `*.ts` 或 `*.js` 文件。

插件模块导出 `default`（或任何命名导出），类型为 `Plugin = (input: PluginInput, options?) => Promise<Hooks>`。导出是一个函数，不是普通对象字面量，并且函数返回一个对象（如果没有什么可注册，返回 `{}`）。

```ts
import type { Plugin } from "@opencode-ai/plugin"

export default (async ({ client, project, directory, $ }) => {
  return {
    config: (cfg) => {
      // cfg 是实时合并的配置；在此处修改字段。
    },
    "tool.execute.before": async (input, output) => {
      // 在工具运行前修改 output.args
    },
  }
}) satisfies Plugin
```

Hook 表面（就地修改 `output`；返回 `void`）：

- `event(input)`：每个 bus 事件
- `config(cfg)`：初始化时，使用合并后的配置调用一次
- `chat.message`、`chat.params`、`chat.headers`
- `tool.execute.before`、`tool.execute.after`
- `tool.definition`
- `command.execute.before`
- `shell.env`
- `permission.ask`
- `experimental.chat.messages.transform`、`experimental.chat.system.transform`、`experimental.session.compacting`、`experimental.compaction.autocontinue`、`experimental.text.complete`

特殊对象形式（不是回调）：`tool: { my_tool: { ... } }`、`auth: { ... }`、`provider: { ... }`。

## MCP servers

`mcp:` 是以 server 名为键的对象。每个 server 由 `type` 区分：

```json
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "env": { "BROWSER": "chromium" }
    },
    "github": {
      "type": "remote",
      "url": "https://...",
      "enabled": true,
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    },
    "old-server": { "enabled": false }
  }
}
```

`command` 是字符串数组。`type` 是必需的。使用 `enabled: false` 禁用从父配置继承的 server。

## 权限

```json
"permission": {
  "edit": "deny",
  "bash": { "git *": "allow", "rm *": "deny", "*": "ask" },
  "external_directory": { "~/secrets/**": "deny", "*": "allow" }
}
```

动作：`"allow"`、`"ask"`、`"deny"`。

每个工具的值的形态：`"allow"` 简写（视为 `{"*": "allow"}`），或 `{ pattern: action }` 对象。在对象内，**插入顺序很重要**。opencode 评估**最后一个**匹配规则，所以把宽泛规则放在前面，窄规则放在最后。

`permission: "allow"`（顶层的字符串）是 "允许一切" 的简写，通常不是用户想要的。

已知的 permission 键：`read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop, skill`。其中一些（`todowrite, question, webfetch, websearch, doom_loop`）只接受扁平动作，不接受按模式的对象。

`external_directory` 模式是文件系统路径（使用 `~/`、绝对路径或如 `~/projects/**` 的 glob）。

按 agent 的 `permission:` 覆盖顶层 `permission:`。Plan Mode 位于 `plan` agent 的 permission 规则集上（`edit: deny *`）。

## 逃生舱

当用户的配置损坏且 opencode 无法启动时，这些 env vars 会有所帮助：

- `OPENCODE_DISABLE_PROJECT_CONFIG=1`：跳过项目的本地 `opencode.json`，只从全局配置启动。从项目目录运行，opencode 加载，用户编辑损坏的文件，然后不带该 flag 重启。
- `OPENCODE_CONFIG=/path/to/file.json`：加载额外的显式配置。
- `OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json"}'`：注入内联 JSON 作为最终的本地作用域合并。
- `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`：跳过默认插件。
- `OPENCODE_PURE=1`：完全跳过外部插件。
- `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`、`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`：跳过 `~/.claude/` 和 `~/.agents/` 下的外部技能扫描。

## 提议编辑时

- 在写入前对照 schema 验证。如果你不确定字段的确切结构，或该字段未在此技能中覆盖，抓取 `https://opencode.ai/config.json` 并阅读 schema，而不是猜测。
- 保留 `$schema` 和用户未要求改动的任何现有字段。
- 对于 agent、skill 和 plugin 定义，优先在正确位置创建新文件，而不是把一切都内联到 `opencode.json`。
- 如果用户现有的配置格式错误，把上面的 env-var 逃生舱指给他们，这样他们就能在不破坏会话的情况下在 opencode 内部编辑。
- 保存任何配置改动后，提醒用户退出并重启 opencode——正在运行的会话会继续使用已加载的配置。
