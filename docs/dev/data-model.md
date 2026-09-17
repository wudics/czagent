# SQLite 数据模型

> 对应 PLAN.md 决策 #3、#11、#21。驱动：better-sqlite3，ORM：drizzle-orm。

## 1. 总览

库文件位置：用户数据目录（`app.getPath('userData')/czagent.db`），由主进程独占打开。单写者模型（better-sqlite3 同步 API，天然单线程安全）。多会话并发读由 drizzle 查询承担，写入集中在 SessionRuntime 的持久化函数。

## 2. 表结构

### 2.1 `sessions` 会话表

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 自增/ULID |
| title | TEXT | 会话标题（首条消息自动生成，可改） |
| mode | TEXT | `chat` \| `script`（脚本编排 P2） |
| agent_id | TEXT | build / plan / 自定义 agent id |
| cwd | TEXT | 会话工作目录（决策 13） |
| model_id | TEXT | 当前对话模型 id（目录中引用） |
| thinking_mode | TEXT | `off` \| `on` \| `deep`（决策 15） |
| status | TEXT | `idle` \| `running` \| `queued`（当前运行态，进程内为准） |
| web_access | INTEGER | 联网开关（I16）：1 开 / 0 关，历史会话默认 1 |
| title_source | TEXT | `user` \| `auto`：用户手动编辑后锁定为 user，自动生成不覆盖 |
| todo | TEXT NULL | todo 工具清单（I18）：TodoItem[] JSON；NULL/空 = 未建立；重启后面板按此恢复 |
| created_at | INTEGER | 毫秒时间戳 |
| updated_at | INTEGER | 毫秒时间戳 |

索引：`(status)`、`(updated_at DESC)`。

### 2.2 `messages` 消息表

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 消息 id |
| session_id | TEXT FK | → sessions.id |
| role | TEXT | `user` \| `assistant` \| `tool` \| `system` \| `compaction` |
| parent_id | TEXT NULL | 前一条消息 id（线性历史） |
| parts | TEXT | JSON 数组，MessagePart[]（见 §3） |
| tokens | TEXT | JSON：`{ input, output, reasoning, cacheRead, cacheWrite }` |
| cost | REAL | 本次消息累计成本（美元） |
| error | TEXT NULL | 失败原因（序列化错误类型） |
| created_at | INTEGER | 毫秒时间戳 |

索引：`(session_id, created_at)`（反向分页锚点）。

> 借鉴 opencode：消息的 body 以 **parts**（增量持久化的 part 数组）存储，文本/推理/工具调用/工具结果都是 part，流式过程不断追加，UI 以 part 为渲染单位。

### 2.3 `session_usage` token 统计表（决策：单会话总 token）

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| session_id | TEXT FK | |
| model_id | TEXT | 贡献 token 的模型 |
| input_tokens | INTEGER | 含缓存总口径 |
| output_tokens | INTEGER | |
| reasoning_tokens | INTEGER | |
| cache_read_tokens | INTEGER | |
| cache_write_tokens | INTEGER | |
| cost | REAL | |
| counted_at | INTEGER | 记账时间 |

**统计口径**：每次 LLM 请求（step-finish）由协议层归一化 usage 后逐轮落一行（主循环经 `reportUsage` 落库并即时广播，不等整轮结束；provider 未回传 usage 时由 finalize 阶段字符估算兜底一行）；**单个会话总 token = `SUM(...)` where session_id=**，即"多次对话总消耗"。UI 展示累计值，并随每次请求实时刷新。

> 契约参考 `packages/llm/src/schema/events.ts`：总量字段是"含缓存含 reasoning 的总口径"（`input = nonCached + cacheRead + cacheWrite`），各分解字段独立存储，消费端不需要做减法。

### 2.4 模型配置（config.json，非 sqlite；决策 5 修订）

> 历史注：本节曾规划 sqlite `model_configs` 表，实际从未落地。模型配置现随 Settings 整体持久化于 `userData/config.json`（`ConfigStore`），不存在对应 sqlite 表。

模型为中心的配置结构（旧 `providers`/`models` 结构启动时检测并重置为空，其余设置保留）：

```ts
interface Settings {
  chatModels: ChatModelConfig[]          // 对话模型：id(自动 mdl-*)/displayName/implId/baseUrl/apiKey/modelName/contextLimit/maxOutput/enabled/toolcall/vision/options
  multimodalModels: MultimodalModelConfig[] // 多模态与专用模型：多 capability/implId/baseUrl/apiKey/modelName/options/enabled
  bindings: CapabilityBinding[]          // 能力 → 模型 id
  agents / permissions / general
}
```

- `implId` 指向代码内置的接口实现注册表（`llm/engines/index.ts`）：chat 为 deepseek / siliconflow / agnes / bigmodel / qwen / openrouter / openai-compatible（兜底）；多模态按能力各有针对性实现 + OpenAI 兼容兜底。元数据（显示名/默认地址/适用能力）在 `llm/engines/catalog.ts`（纯，渲染层直引）。
- 解析与校验统一收敛于 `llm/gateway.ts`（唯一入口）；未注册/未配置 Key 主动中文报错，不发未知请求。

### 2.5 `attachments` 附件表

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT FK | |
| message_id | TEXT NULL | 关联到哪条消息 |
| name | TEXT | 原始文件名 |
| kind | TEXT | txt/md/docx/xlsx/pptx/pdf/image/other |
| size | INTEGER | 字节 |
| stored_path | TEXT | temp 目录内绝对路径 |
| inline | INTEGER | 1=已解析内联进消息，0=文件引用 |
| created_at | INTEGER | |

### 2.6 `kv` 键值表（通用配置辅助）

| 列 | 类型 |
|---|---|
| key | TEXT PK |
| value | TEXT |

用途：UI 布局状态、上次 cwd、窗口状态（可选）、schema 版本。

## 3. MessagePart 结构（消息正文）

```ts
type MessagePart =
  | { type: 'text'; text: string; synthetic?: boolean }             // 正文，流式追加；synthetic=仅展示不进请求（如 plan 可见全文）
  | { type: 'reasoning'; text: string }                             // 思考内容（决策 15：内联，非独立消息）
  | { type: 'image'; dataUrl: string; name?: string }               // 富输出/附件图片
  | { type: 'tool-call'; tool: string; callID: string;
      input: unknown; state: 'pending'|'running'|'completed'|'error'; title?: string }
  //   pending=流式中参数未齐（tool-call-start 即建卡，不等整条流结束）
  | { type: 'tool-result'; callID: string; output: unknown;
      state: 'completed'|'error'; error?: string }
  | { type: 'error'; message: string }                              // LLM 错误/压缩失败等可见错误
  | { type: 'file'; path: string; name: string; kind: string }      // 附件引用（大文件/PDF/生成文件）
  | { type: 'compaction'; summary: string; coversBefore?: number }  // 压缩 checkpoint；
  //   coversBefore=语义边界（摘要覆盖到该时间戳为止），显示位置 createdAt=压缩完成时刻（时间线底部）
```

## 4. 会话状态机

```
queued ──(取到并发名额)──► running ──(收到新消息)──► running（新一轮）
                          │   │
                          │   ├──(完成/停止/错误)──► idle
                          └──► idle ──(发送消息)──► running
```

- `idle`：无活动任务；历史按需从 DB 懒加载。
- `running`：SessionRuntime 驻留内存，有活动 loop。
- `queued`：达到并发上限（默认 4）时新任务排队，UI 显示排队状态。
- 会话切换不打断 running（决策 21）。

## 5. 持久化策略

- **增量写 + 节流**：流式 delta 只发事件，`updateMessageParts` 以 200ms 节流落库（同一条消息多次更新）；结束时 `finalizeMessage` 全量兜底。崩溃后窗口重开从 DB 恢复（最多丢最后 200ms 的半截文本）。
- **压缩**：DB 非破坏（旧消息全量保留），checkpoint 为 user 角色消息追加落库；请求窗口按 checkpoint 的 `coversBefore` 语义边界跳过旧段（见 agent-loop.md §5.4）。
- **清理**：会话删除级联删 messages/usage/attachments；附件 temp 文件在会话清理/退出时删除。

## 6. 反向分页（配合虚拟滚动，决策 14）

`getMessages(sessionId, { beforeId?, limit=50 })`：按 `created_at DESC` 以 `beforeId` 为锚点取上一页；返回页内按时间升序排列，附 `hasMore`。UI 向上滚到顶加载上一页并"钉住"滚动位置。
