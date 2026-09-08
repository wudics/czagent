# 033 · I17 — 多模态全能力 profile 化 + 视频任务关键信息 + 富输出链路修复

日期：2026-09-07
前置：用户反馈三件事——①多模态接口兼容性要能兜底（有特定实现用特定、否则兼容、最次明确报错）；②视频工具返回要带 video id 等关键信息；③顺带核实富输出链路失效问题。chat 侧继续不动（OpenAI 兼容够用，不接 Anthropic）。

## 决策（用户拍板）

- 全部 8 个多模态能力立即 profile 化（非仅视频）；设置页徽标**只展示**解析结果，不加配置项。
- 2.5 家族 `mode` 值新旧文档矛盾（代码旧实测 `ti2vid/keyframes` vs 最新官方文档 `text/keyframe`）→ **自动探测**：先发文档值，创建 400（不建任务不计费）回退旧实测值，成功值进程内缓存。
- 富输出 bug 纳入本轮修复（模型收到含 base64 的整段 JSON 才是 token 灾难；修复后模型只收短文本）。

## 架构

```
core/src/adapters/
  types.ts       MMBinding/MMCtx/MMFeature + FEATURE_LABEL + 各能力 ProfileImpl 接口 + VideoTaskResult + ProfileDesc/Meta
  registry.ts    纯函数（无 node 依赖，渲染层可直引）：detectStyle + PROFILE_DESCRIPTORS(13 条) + resolveProfileMeta
  shared.ts      postJson(抛 HttpError 带 status)/readProgress/pollIntervalOf 等（statusStarted 占位实现删除）
  profiles/
    video.ts     agnes-video-v2.0（旧格式，num_frames 8n+1 钳制）/ agnes-video-2.5（mode 探测+缓存，含 2.5-flash）/ siliconflow-async（requestId）
    image.ts     agnes-image（档位 size + extra_body.image 图生图）/ openai-image（image_size 精确像素）
    embedding.ts openai-embed / openai-rerank
    audio.ts     openai-tts / openai-asr
  index.ts       resolveCapability(feature, pick)：解析链 × 实现绑定（node 侧入口，工具层唯一调用点）
```

- **解析链（8 能力统一）**：特定实现（`match(model)` 命中，kind=specific）→ 风格默认兜底（kind=default）→ 无实现统一报错 `X当前不支持该模型「model」所属接口（风格名），请到「设置 → 模型」换绑对应能力的模型`（不发未知请求）。apiStyle 判定逻辑不变（显式 > providerId=agnes > agnes- 前缀）。
- `MMAdapter` 大接口与 `pickAdapter/ensureSupport` 退役；`agnes.ts/openai.ts` 拆入 profiles。
- **兜底实例**：`agnes-video-9.9`（未知未来模型）→ 兜底 2.5 格式；`2.5-flash` 官方确认复用 2.5 接口（仅 size 固定 720P 与 reference 媒体数校验差异，本工具只涉 text/keyframe 模式）→ 直接命中 2.5 profile。

## 变更

- **视频任务关键信息**：`videoFromText/videoFromFrame` 返回 `VideoTaskResult`（url/videoId/taskId/model/implementation/queryUrl）；创建成功即 `ctx.report('视频任务已创建（video_id=…）')` 轮询卡片可见；工具最终富输出文本含 模型（接口实现名）/视频 ID/任务 ID/来源 URL/耗时/本地文件。
- **v2.0 帧数钳制**：`num_frames = ceil((round(s*24)-1)/8)*8+1`，满足官方 8n+1 且 ≤441（非整数秒此前会 400）。
- **富输出链路修复（原有 bug）**：multimodal 8 工具此前 `JSON.stringify(richOutput(...))` 返回字符串，而 `isRichToolOutput` 只认对象 → 富输出从未生效，模型收到含 base64 的整段 JSON（token 灾难）。现直接返回对象：模型只收 text，images/files 正确落 part。已核实上下文构建只内联**用户消息**图片（session-manager L101-128），助手生成图片 part 不进模型上下文。
- **渲染层**：`MessagePartView` 补 `case 'image'`（限宽懒加载）；`kind:'video'/'audio'` 文件 chip 升级内联 `<video>/<audio controls>` + chip 兜底；新增 `czagent-file://` 特权协议（main 侧 `protocol.handle` + `net.fetch(pathToFileURL)`，stream 支持，路径逐段编码防 `#`/空格/中文）。
- **设置页**：能力绑定区 6 项多模态绑定行显示接口实现徽标（`resolveProfileMeta` 纯函数直调，describe + 特定实现/兼容兜底；绑错风格红色「不支持该接口，请换绑模型」）。i18n zh/en。
- **其他修复**：「已等待 Ns」此前恒 0（statusStarted 占位实现）→ 轮询本地记起始时间；SF/Agnes 轮询进度统一。

## 测试（core 18 = 旧 5 + 新 13）

- detectStyle 四态 + apiStyle 双向覆盖；resolveProfileMeta 矩阵（v2.0/2.5-flash 特定、未知 agnes 兜底、openai 视频兜底、图像三态、embed/rerank/tts/asr 绑 agnes 报错）。
- 2.5 全流程 e2e（mock fetch）：VideoTaskResult 字段、富输出对象、进度含 video_id；mode 探测 400→回退→缓存（二次调用单请求）；请求体字段。
- v2.0 请求体（9:16 尺寸映射 + 8n+1 帧数钳制 5.5s→137）；图像富输出（text 不含 base64）；tts 绑 agnes 报错且 fetch 未调用。

## 验证

- `pnpm typecheck` ✅（core + desktop）· `pnpm test` ✅（core 18）· `pnpm --filter @czagent/desktop build` ✅（renderer 1921 模块含 registry 无 node 依赖）。
- 待用户 Electron 冒烟：视频内联播放（czagent-file 协议）、设置页徽标、2.5-flash 实跑（mode 探测日志）。

## 边界与后续

- mode 探测缓存为进程级，重启后首轮可能多一次 400 探测（无害，不计费）。
- `czagent-file` 协议未做 Range 请求转发，>64MB 大视频 seek 依赖 Chromium 缓冲（生成文件上限 64MB，影响有限）。
- 后续接入新模型分叉 = registry 加一条 descriptor + profiles 加实现；chat 适配器化仍留待接 Anthropic/Gemini。
