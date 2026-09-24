# 048 · websearch 接入 AI 检索（百度千帆 + Exa，级联优先 HTML 兜底）

日期：2026-09-24
前置：047（同工作区未提交改动）。

## 需求

现有 websearch 只有「抓搜索结果页 HTML → 解析」一条路（必应/百度/360/搜狗，反爬脆弱、解析器易随改版失效）。用户要求：新增专为 AI 设计的结构化检索——百度千帆 web_search 与 Exa；**全部开启时优先级：百度搜索(AI) → Exa → 现有 HTML 方式**（HTML 为兜底）；配置页控制开关。

## 变更

- **`tools/websearch/types.ts`**：新增 `AiSearchProvider` 接口（`id: 'baidu-ai'|'exa'` + `configKey`（映射 `general.websearch.ai` 的 baidu/exa）+ `search(req)` 抛错 = 编排层静默降级）与 `AiSearchRequest`。
- **`fetcher.ts` 新增 `fetchJsonPost`**：API 专用 JSON POST，20s 超时合并 signal；非 2xx / 非法 JSON 抛带响应体截断的错误。**不参与 2s HTML 抓取节流**（那是反爬约束，正式 API 不需要）。
- **`engines/baidu-ai.ts`**：千帆 `POST https://qianfan.baidubce.com/v2/ai_search/web_search`（`Authorization: Bearer <API Key>`）；body `{messages:[{role:'user',content:query}], search_source:'baidu_search_v2', resource_type_filter:[{type:'web',top_k:maxResults}]}`；**query 按权截 72**（汉字计 2，`truncateBaiduQuery` 单测覆盖）；响应异常走 `code/message`；结果 `references[].{title,url,snippet}`（snippet 缺回退 content；title 缺回退 web_anchor/website）。
- **`engines/exa.ts`**：`POST https://api.exa.ai/search`，`{query, type:'auto', numResults:min(maxResults,100), contents:{text:false,highlights:{maxCharacters:500},summary:{}}}`——只取摘要不取全文（明细留给 webfetch，控响应体与成本）；错误提取 `error(tag)`；结果 `results[].{title,url,summary|highlights[0]|text}`。
- **编排 `websearch.ts`**：AI 级联 → 首个「启用 && apiKey 非空 && 有结果」即止；失败/空/缺 Key 静默落下一档；随后走原 HTML 多引擎翻页兜底（该路径行为零改动）。AI 结果与 scrape 结果共用 `dedupeByUrl + rankResults + formatResults`（输出格式统一，来源以 `引擎：baidu-ai|exa|bing…` 标注）；全失败文案升级 `搜索不可用（AI 检索失败或未启用，HTML 引擎亦全部失败）…`。工具 description 首行加「优先 AI 结构化检索」。
- **配置**：`GeneralSettings.websearch` 增 `ai?: { baidu?: {enabled, apiKey}, exa?: {enabled, apiKey} }`（**默认 enabled=false**，向后兼容；Key 存 settings JSON 本机，模型 API Key 同安全级）。
- **设置页（权限 → 网页搜索）**：HTML 引擎开关芯片 → **上方**新增「AI 检索」区：两行（百度千帆/Exa）各 Switch + 密码式 API Key 输入框；**开关键空显式提示**（附申请控制台地址），运行期自然降级 scrape。i18n zh/en 5 个新键。
- 会话 `webAccess` 总开关语义不变（继续同时禁 webfetch/websearch）。

## 验证

- 新增 `packages/core/test/websearch.test.ts` 5 例：baidu-ai 命中即止（不触 scrape/去重/兜底映射）、截断与请求体（36 汉字截断、top_k=numResults=maxResults）、baidu 402→级联 exa（不进 scrape）、开关键空跳过→HTML 兜底、全失败明确文案。core 106 测试全绿；`pnpm -w typecheck`、desktop `electron-vite build` 通过。
- 文档：`docs/dev/tools-and-permissions.md` §5 重写（AI 级联规格 + 配置键）；`ui-design.md` 设置表更新。

## 用户验收（需真实 Key）

1. 设置 → 权限 → 网页搜索：开「百度 AI 搜索」并填千帆 API Key → 发一句"联网搜索 X"，回答应引用来源且结果头部为 `引擎：baidu-ai`。
2. 关 baidu-ai 开 Exa + Key → 应命中 `引擎：exa`；两 AI 都开时只调 baidu（首个命中）。
3. baidu Key 故意填错 → 自动落 exa 或 HTML 引擎，工具输出头部显示实际来源；AI 区开关键空有琥珀提示。
4. AI 全关 → 行为与本改动前完全一致（scrape 链）。

## 遗留

- Exa 用 `auto` type；高延迟场景可评估 `fast`/`instant` 配置化（本轮有意不加，避免选项爆炸）。
- 结果条数 `maxResults` 对两端语义分别钳制（baidu top_k≤50 / exa≤100）；聚合"多路并行合并"不在本轮范围（用户确认级联语义）。
