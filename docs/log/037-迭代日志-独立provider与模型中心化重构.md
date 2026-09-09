# 037 · 独立 Provider 与模型中心化重构

日期：2026-09-09
前置：用户反馈 provider/模型管理体验割裂——旧体系以"provider"为第一公民（配置 provider → API Key → 目录式模型列表），新增模型要先进 provider 再进模型，且多模态能力模型与 chat 模型管理入口不一致；请求路由靠 adapters 隐式猜测（按 baseUrl 正则匹配），行为不透明。

## 现状结论（调研）

- 旧配置结构 `providers[] → models[]` 两层嵌套，模型无法脱离 provider 独立存在；多模态模型复用 `models[]` + capability 字段，UI 与校验都绕。
- 请求路由（`llm/client.ts` + `llm/profile.ts` + `adapters/`）按 provider id 隐式选 profile，新接一家要改多处；"新增 provider"概念与"接口实现"耦合，无 API 版本粒度。
- `ChatStreamRequest` 与业务消息结构耦合在 client 层，options（temperature 等模型级参数）无落地路径。
- UI 侧模型管理、mock 场景、settings storage 均围绕旧结构展开，i18n 文案以 provider 为主线。

## 决策（用户拍板）

- **模型为中心**：chat 模型每条自带 implId/baseUrl/apiKey/modelName，完全自包含；provider 仅是"接口实现选择"下拉，不再有 provider 管理界面。
- **每家独立引擎**：每家 provider（API 版本算新 provider）一个独立对话引擎文件，协议差异（thinking 参数、reasoning 字段名）写死在各自实现内；OpenAI 兼容实现作为兜底；最坏情况显式中文报错，绝不向未知地址发请求。
- **共享仅限底层原语**：HTTP 重试、SSE 解析、tool-call 增量聚合、usage 归一化放 `engines/http.ts` + `openai-stream.ts`，各引擎通过参数注入差异。
- **多模态全独立**：视频/图像/embedding/rerank/TTS/ASR 按单模型粒度选择实现，与 chat 模型同构管理。
- **旧配置重置**：检测到 `providers`/`models` 旧结构 → 模型相关配置清空重来，其余设置保留；不做迁移、不加预设模板补偿。
- **能力绑定区保留**：绑定候选按能力类型过滤（chat → 对话模型；其余 → 对应多模态模型）。

## 变更

### core（类型与网关）

- **`provider.ts`**：删除 `ProviderConfig`/`ModelConfig`；新增 `ChatModelConfig`（id 自动 `mdl-*`/displayName/implId/baseUrl/apiKey/modelName/contextLimit/maxOutput/enabled/toolcall/vision/options）与 `MultimodalModelConfig`（capability/implId/baseUrl/apiKey/modelName/options/enabled）；`ChatImplId`/`MMImplId` 字符串联合；`Settings` 平铺为 `chatModels`/`multimodalModels`/`bindings`/`agents`/`permissions`/`general`；`Capability` 收敛为 8 个（移除无实现的 `fim`/`video-understanding`），新增 `MULTIMODAL_CAPABILITIES`。
- **`llm/types.ts`**：删 `ChatStreamRequest`；新增 `ChatBinding`（baseUrl/apiKey/modelName）与 `ChatReq`（纯业务字段：messages/thinking/maxTokens/signal/tools/options）；引擎接口统一为 `ChatEngine.stream(b: ChatBinding, req: ChatReq)`。
- **`llm/gateway.ts`（新，唯一入口）**：`Gateway` 类提供解析与路由——`resolveChat` 产出扁平化 `ResolvedChat`（modelId/displayName/binding/engine/vision/toolcall/maxOutput/contextLimit/options），抹平 chat 与 image-understanding 模型差异；`chat()` 合并模型级 options 与请求级 options（调用方优先，修复旧 options 死字段问题）；`embed/rerank/generateImage/editImage/generateVideo/videoFromFrame/tts/asr` 按能力绑定分发；未注册/未配置 Key/能力未绑定均中文报错。
- **共享原语**：`engines/http.ts`（`fetchJsonWithRetry`：429/5xx 指数退避、retry-after 语义）、`engines/openai-stream.ts`（`buildOpenAiMessages` 组装含图片 content 块与 reasoning 回传、`consumeOpenAiStream` SSE→LLMEvent 含 tool-call 增量聚合与 finish 即断流、`streamOpenAiChat` 管道）、`engines/mm.ts`（多模态共用：postJson/下载转 dataUrl/输出提取/进度解析）。
- **chat 引擎**：`engines/chat/{deepseek,siliconflow,agnes,openai-compatible}.ts` 四个独立文件——deepseek 用 `thinking:{type}`+`reasoning_effort` 且工具场景强制回传历史 reasoning；siliconflow 用 `enable_thinking`+`thinking_budget`；agnes 用 `chat_template_kwargs.enable_thinking`；openai-compatible 无任何平台差异参数。
- **多模态引擎**：视频 `agnes-v20`（旧格式 width/height/num_frames 8n+1≤441）/`agnes-2.5`（seconds/mode/size=720P，`probe.ts` 探测 mode 合法值并缓存）/`siliconflow`（异步任务轮询）；图像 `agnes`（size 档位 + 图生图）/`openai`（精确像素）；embedding/rerank/TTS/ASR 各 OpenAI 兼容实现。
- **注册表**：`engines/catalog.ts`（`CHAT_IMPL_META`/`MM_IMPL_META`/`implMetaOf`，纯元数据无 node 依赖，渲染层直引预填默认地址）+ `engines/index.ts`（implId → 引擎实例）；两者 id 一一对应，缺失即未同步。
- **`session-manager.ts`**：全部 LLM 调用点（主循环/压缩/摘要/标题/图片理解/子代理/脚本会话）改走 Gateway；`engineFor` 注入点供测试；主循环每轮重解析 `turnTarget`（失败回退会话创建时快照）；ToolContext 注入 gateway。
- **配置**：`settings-defaults.ts` 模型默认空（不再内置三家模板）；`config/file.ts` 检测 `providers`/`models` 旧字段 → 模型重置。
- **删除**：`llm/client.ts`、`llm/profile.ts`、`adapters/` 整目录。

### desktop（UI）

- **模型设置页重写**（`ModelsTab.tsx`）：三区——对话模型 / 多模态模型 / 能力绑定；添加对话框按 implId 预填默认地址、同实现已有模型自动复用 Key；绑定区下拉按能力过滤候选。
- **`stores/settings.ts`** 重写：`addChatModel`/`addMultimodalModel`/`updateBinding`/`rebindAll` 等动作 + `chatModels()`/`modelById()`/`bindingOptions()` 派生方法（含使用约束注释）。
- 会话入口（InputBar 模型切换、NewSessionDialog、AgentsTab）改用 `chatModels()` 候选 + `implMetaOf` 展示实现徽标；新增共享组件 `ModelName.tsx`（侧栏/右栏显示模型名与实现）。
- i18n（zh-CN/en-US）`settings.models.*` 全量重写；mock 场景/mockProvider/settingsStorage 对齐新结构（含旧结构重置）。

### 测试

- `core/test/adapters.test.ts` 重写：19 项覆盖 Gateway 路由与校验（模型缺失/Key 缺失/implId 未注册/能力未绑定均中文报错）、四家 chat 引擎思考档位差异、reasoning-delta 事件与 usage 归一化、tools/options/maxTokens 注入、agnes 2.5 mode 探测与缓存、v2.0 旧格式、图像/TTS、目录一致性。

### 过程修复

- 渲染层无限重渲染（Maximum update depth）：`useSettingsStore((s) => s.chatModels())` selector 内 filter 产生新数组引用 → useSyncExternalStore snapshot 永远不一致；改为 selector 只选 `settings` 稳定引用 + 组件内 `useMemo` 派生（InputBar/NewSessionDialog/AgentsTab 三处），并在 store 派生方法上注明使用约束。

## 验证

- `tsc --noEmit`（core + desktop）✅ · `vitest` core 39/39 ✅ · `pnpm -r build` ✅（electron-vite 三端）。
- 新增 provider 步骤收敛为四步：`llm/engines/chat/` 新引擎文件 → `engines/index.ts` 注册 → `catalog.ts` 元数据 → `provider.ts` 联合类型加字面量。
- 待 Electron 冒烟：添加模型→会话、图片附件理解、文生图/视频、会话中切换模型；旧 config.json 启动重置确认。
