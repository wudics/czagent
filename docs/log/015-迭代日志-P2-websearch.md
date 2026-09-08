# 015 · 迭代日志 — P2 websearch

> 日期：2026-09-03
> 状态：✅ 完成（构建/测试/真机抽样/Electron 冒烟通过）
> 对应：`docs/log/000-开发计划总览.md` → P2 websearch（决策 17 / R2）

## 目标

自研抓取国内搜索引擎（不依赖第三方搜索 API），结果列表供 agent 阅读后用 webfetch（落盘+预览机制）抓详情页。

## 完成项

### 1. Core 模块（`core/src/tools/websearch/`）
- [x] `types.ts`：`SearchResult {title,url,snippet}` + `SearchEngine {buildUrl, parse}` 接口（每引擎独立模块，结构变化只影响单引擎）
- [x] 4 引擎解析器：**Bing CN**（`b_algo` 块，first=1/11/21 翻页）、**百度**（`<h3>` 锚点切分 + content-right 摘要，pn=0/10/20，/link 跳转链接保留）、**360**（res-list 块）、**搜狗**（vrwrap 块，/link 相对链接补全域名）
- [x] `fetcher.ts`：真实浏览器 UA + Accept-Language；**全局节流 ≤1 次/2s**（防反爬）；编码检测（content-type / meta charset → GBK/UTF-8，百度系 GBK 页容错）；15s 超时 + `ctx.signal` 中断（AbortSignal.any）
- [x] `parse-util.ts`：stripTags / decodeUrl / absoluteUrl（容错：提取不到即跳过）
- [x] 编排（`websearch.ts`）：**引擎降级链**（按固定优先级 try each → 首个有结果者；解析空/网络失败自动下一个）；**翻页 ≤3** 聚合去重（url 去重）；**相关性打分**（query 分词——英数单词 + CJK 单字——title 命中 ×3 / snippet ×1）；输出编号列表 + 尾部引导"高匹配结果用 webfetch 抓详情"；全失败 → `搜索不可用…可改用 webfetch 直达 URL`

### 2. 配置 + 设置页
- [x] `GeneralSettings.websearch = { engines, maxResults }`（默认 4 引擎全启用、8 条；旧配置经 DEFAULT_GENERAL 合并自动补齐）；**空数组语义 = 全部停用**（undefined = 未配置默认全启）
- [x] **PermissionsTab 新增「网页搜索」节**：4 引擎开关（开关只决定启用集合，降级顺序固定 必应→百度→360→搜狗）+ 结果条数 NumInput（1–20）；zh/en i18n
- [x] 请求间隔 2s 为常量不暴露 UI（防误设过低触发反爬，文档偏差已记录）

### 3. 接入
- [x] registry 注册 `websearch`（build 全量注入）；`DEFAULT_PERMISSIONS` 加 `{websearch: allow}`（迁移自动补齐）
- [x] **plan agent tools 恢复 websearch**（设计原有；allow 列表同步）

### 4. 实施中发现并修复
- `engineOrder` 把空数组当"未配置"回退全量 → 与设置页"全部停用"语义冲突（且导致测试真实联网）→ 改为 `?? `（仅 undefined 回退）
- 编排测试 stub 的 `includes('first=1')` 误匹配 `first=11`；节流 stub 复用同一 Response（body 已读）

## 验证结果

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ core + desktop |
| `pnpm test` | ✅ core 121/121（+12：4 引擎解析 fixture、GBK 解码、翻页≤3/去重/截断、打分排序、降级、全失败、全停用、节流）+ desktop 11/11 |
| `pnpm build` | ✅ main 297KB |
| **真机抽样** | ✅ 2 个真实中文查询（"Electron 桌面应用开发"/"2026 年国庆节放假安排"）均由 Bing CN 返回 8 条高质量结果（知乎/CSDN/官方文档/gov.cn，标题/URL/摘要完整），单查询 <2s |
| `pnpm dev`（Electron） | ✅ 无渲染错误 |

## UI 修复（验收反馈）

- [x] **外链覆盖应用页面**：点击 markdown/websearch 链接会在窗口内导航走——主进程 `createWindow` 补两层拦截：`setWindowOpenHandler`（target=_blank/window.open）+ `will-navigate`（普通 `<a>` 点击，仅渲染进程发起导航时触发，应用自身加载不受影响）；白名单 `http(s)`/`mailto:` → `shell.openExternal` 系统默认浏览器/邮件客户端，**其余协议一律拒绝**（安全兜底）；应用内锚点不拦截

## 边界与后续
- 百度/搜狗/360 三个解析器按公开页面结构编写、fixture 单测覆盖，但未真机命中（Bing 首选即成功）——若后续 Bing 被反爬，真机再校准（解析器隔离，预期成本低）
- 请求间隔/引擎优先级为常量；如需用户可调再迭代
- 下一 P2 大件：**脚本编排**（DSL + 执行器 + ctx.agent.run + script 模式 UI）
