# 工具与权限

> 对应 PLAN.md 决策 #6、#13、#16、#17、#18。设计参考 `docs/ref/opencode-1.18.19-src/packages/opencode/src/tool/` 与 `permission/`。

## 1. 工具注册表

```ts
interface ToolDef {
  id: string;                       // 全局唯一
  description: string;              // 注入给模型的描述
  inputSchema: JSONSchema;          // 参数 schema（校验入参）
  execute(input: unknown, ctx: ToolCtx): Promise<ToolOutput>;
  permission?: { action: PermissionAction; patterns?: string[] }; // 默认授权动作
}

interface ToolCtx {
  sessionId: string;
  cwd: string;                      // 会话工作目录（边界）
  ask(req: PermissionRequest): Promise<PermissionDecision>;
  messages: Message[];              // 只读上下文（模型可见的历史）
  signal: AbortSignal;
  metadata: (patch) => void;        // 流式更新 tool part（标题/状态）
  modelRegistry: ModelRegistry;     // 供能力工具选择模型实例（决策 6）
}
```

- 注册表 `resolve(agent.permissions)` 做工具过滤（disable 列表、agent 权限合并）。
- 执行管线：`plugin.before → 权限断言 → inputSchema 校验 → execute → outputSchema 校验 → ToolOutput 规范化（输出上限/图片附件压缩）→ tool-result 事件`。

## 2. 内置工具清单

### 2.1 P1（MVP）

| 工具 | 说明 | 权限动作 |
|---|---|---|
| `read` | 读文件（支持 offset/limit），cwd 外也允许读 | `read`（cwd 内自动放行） |
| `write` | 写文件（cwd 内；cwd 外询问） | `write` + 路径检查 |
| `edit` | 精确字符串替换编辑（先 read 后 edit 模式） | `edit` + 路径检查 |
| `patch` | apply_patch 格式批量补丁（参考 opencode `apply_patch.ts`） | `edit` + 路径检查 |
| `grep` | 内容搜索（支持正则、include 过滤） | `grep` |
| `glob` | 文件名匹配 | `glob` |
| `bash` | 终端命令（node-pty，见 §4） | `bash` + 路径检查 |
| `webfetch` | 抓取网页 → markdown | `webfetch` |
| `todowrite` | 维护任务清单（写入会话 todo 列表） | `todowrite` |
| `plan` / `plan-exit` | 进入/退出 plan 模式（决策 18）。plan 提交经富输出把计划全文追加为可见 markdown part（用户直接可读，模型只收短文本）；plan-exit 拒绝 → `UserRejectedError` 终止本轮、留在 Plan 模式 | —（模式切换） |

### 2.2 P2 扩展

| 工具 | 说明 |
|---|---|
| `websearch` | 自研国内搜索（见 §5） |
| `skill` | 动态加载 skill（见 skills-and-mcp.md） |
| `task` | 子代理委派（决策 6 的 P2 部分） |
| `embedding` / `rerank` | 向量能力工具（绑定 embedding/rerank 模型实例） |
| `image_generate` / `video_generate` | 生成类工具（绑定生成模型实例，可指定模型 id） |
| `tts` / `asr` / `image_understand` | 语音/视觉能力工具 |

## 3. 权限模型（决策 13）

### 3.1 边界
- **会话 cwd** 内及其子目录：读写全权（无需询问）。
- **cwd 外**：读取允许（只读）；写入/编辑/删除/重命名 → 弹权限确认，默认拒绝。
- **bash**：cwd 内命令直接执行；cwd 外的破坏性命令（`rm -rf`、`rm` 到外部路径、写系统目录等）需确认；危险模式内置黑名单启发式 + 正则白名单（参考 opencode `permission/` 的 bash 判定）。

### 3.2 规则（agent 配置的 `permission` 字段）
```
permission: {
  allow: [ "read", "grep", "glob" ],
  deny:  [ "bash" ],
  ask:   [ "write", "edit" ],      // 默认未列出的敏感工具进入 ask
  rules: [                          // 路径级规则（P2 增强）
    { action: "write", pattern: "/path/to/project/**", mode: "allow" }
  ]
}
```
合并顺序：agent.permission（build/plan 默认）→ 会话级权限 → 用户 `user.tools` 禁用表。

### 3.3 询问流程
- 工具执行前 `ctx.ask(...)` → 主进程发 `permission.request` 事件 → UI 弹窗展示工具名/参数/目标路径，三选一：**允许本次 / 允许本次及以后（写入规则）/ 拒绝**。
- 拒绝 → 工具结果记 error 并**终止本轮 loop**（权限层 deny 与工具内 `ctx.ask` 抛 `UserRejectedError` 同一管线，见 agent-loop.md §2）；`general.continueLoopOnDeny = true` 可恢复"错误反馈给模型继续"旧行为。
- **doom-loop**：同一工具同一参数连续 3 次 → 询问（防死循环烧 token）。

## 4. bash 工具（决策 16）

- **node-pty**（`@lydell/node-pty`，Electron 适配版）：
  - Windows → `powershell.exe`
  - Linux/macOS → `bash` / `zsh`
- 每次调用独立 pty（cwd = 会话工作目录，无需 cd）：
  - 不支持交互式输入（交互命令挂起直到超时，工具描述引导用非交互参数）
  - ANSI 颜色剥离（stripAnsi）后返回纯文本
- 输出上限：单次命令输出截断（30k 字符），超限截断提示。
- 超时（对齐 opencode shell 工具模式）：
  - 每调用可选 `timeout` 参数（正整数毫秒，不设上限；负数/0/非整数报错），默认 120000ms
  - **超时不抛错**：kill 后返回已捕获的部分输出 + `<shell_metadata>` 中文提示（"若命令确实需要更长时间……请传更大的 timeout 参数重试"），`exitCode: 124`（GNU timeout 惯例）
  - 用户中止：kill 后正常返回部分输出 + "用户中止了命令"，`exitCode: 130`
- **平台差异**：Windows 用 `powershell -NoProfile -NonInteractive -Command` 语义，脚本/路径分隔符差异在工具描述中说明（平台感知双分支描述）。

## 5. websearch（决策 17，P2；048 升级 AI 检索）

AI 结构化检索优先（百度千帆 → Exa），HTML 抓取国内搜索引擎作兜底：

- **AI 引擎（级联，启用且 Key 非空才参与）**：
  - `baidu-ai`：千帆 web_search API（`qianfan.baidubce.com/v2/ai_search/web_search`，Bearer API Key；query 按权截 72 字符=汉字计 2；结果取 `references[].{title,url,snippet|content}`；月免 1500 次）。
  - `exa`：`api.exa.ai/search`（`type=auto`，`contents` 只要 summary/highlights 不要全文；结果取 `results[].{title,url,summary|highlights[0]}`）。
  - 任一成功且非空 → 直接返回（同一相关性排序与输出格式）；未启用/HTTP 失败/空结果 → 静默降级下一档。**不参与 HTML 抓取节流**（正式 API 无防爬需求）。
- **HTML 兜底引擎**：必应、百度、360、搜狗，按可用性降级（`try each → 首个返回结果`）。
- **流程**：
  1. 构造各引擎搜索 URL（带 query + 翻页参数）。
  2. 抓取 HTML → 按引擎解析器提取 `[{ title, url, snippet }]`（编码容错：UTF-8/GBK 自动检测）。
  3. 相关性打分（标题/摘要与 query 关键词匹配）排序。
  4. **内容不足时翻页**：翻页最多 3 次，聚合去重。
  5. 对高匹配结果，agent 可用 `webfetch` 抓详情页（工具描述中引导）。
- **风险应对**：反爬（UA、延时、频率限制 ≤1 次/2s）、解析器隔离（每引擎一个模块，结构变化只影响单引擎）、失败静默降级。
- 配置（`general.websearch`）：AI 引擎逐条 `{ enabled, apiKey }`（设置页「权限 → 网页搜索」，开关开但缺 Key 显式提示；key 明文存本机 settings JSON，与模型 API Key 同安全级）、HTML 引擎开关、结果条数。

## 6. 工具结果回填

- 工具输出按 `ToolOutput { output, title, metadata, attachments }` 结构化。
- 富输出（`RichToolOutput`，tools/rich-output.ts）：`images`/`files` 追加为独立可见 part；`markdown` 追加为 `synthetic: true` 的 text part（仅展示、不进请求——`buildRequestMessages`/自动标题/用量估算三处过滤，防止与 tool-call 参数双份入上下文）；模型一律只收 `text` 短文本。
- 文本输出直接作为 tool-result part；图片附件经压缩后按 data URL / 文件引用回填。
- 下一轮请求时，assistant 消息的 tool-call + tool-result parts 转回 `tool_calls` 与 `role:tool` 消息（DeepSeek 需同时回传 `reasoning_content`，见 llm-engine.md §4.2）。
- 工具报错 → `result.type:'error'`，模型下一轮可见错误描述（允许自纠；plan-exit 等哨兵拒绝除外——直接终止本轮）。
