# 042 · OpenAI 兼容命名修正 + 聊天长链接折行

日期：2026-09-10
前置：040/041 合入后使用反馈两处 UI 问题。

## 问题（用户反馈）

1. 设置页添加模型时接口实现下拉显示「OpenAI 兼容（自定义）」，"（自定义）"后缀多余。
2. 聊天内容出现超长 URL（如百度百科百分号编码链接，连续无空格 token）时不折行，把容器撑破产生整页横向滚动条。

## 决策（用户拍板）

- 显示名去掉"（自定义）"后缀，仅保留「OpenAI 兼容」（补充说明仍在下拉 title 中）。
- 断行策略：正文（含列表、链接、表格内长 URL）在任意字符间折行；代码块保持行对齐不折行，超宽行在代码块内部横向滚动；聊天区滚动容器整体禁横向滚动作兜底。

## 变更

- **`core/src/llm/engines/catalog.ts`**：`openai-compatible` 显示名 `'OpenAI 兼容（自定义）'` → `'OpenAI 兼容'`（渲染层 ModelsTab/InputBar/NewSessionDialog 均直引 `implMetaOf().name`，一处改动全局生效）。
- **`desktop/.../styles/globals.css`**：
  - `.markdown-body` 加 `overflow-wrap: anywhere`（可继承，作用于 a/li/td/inline code；并收敛 min-content，从根上防 flex/绝对定位容器被撑破）。
  - `.markdown-body pre` 加 `overflow-wrap: normal` 豁免——代码块保持行对齐，靠自身 `overflow-auto` 内部滚动。
- **`desktop/.../components/chat/MessageItem.tsx`**：用户消息文本加 `wrap-anywhere`（Tailwind v4 工具类，`overflow-wrap: anywhere`）；用户气泡容器加 `min-w-0` 防御。
- **`desktop/.../components/chat/MessagePartView.tsx`**：5 处 `whitespace-pre-wrap` 纯文本容器补 `wrap-anywhere`（LongText 三个 `<pre>`、ReasoningView、CompactionView）——`pre-wrap` 只在空白处折行，长 token 同样会溢出。
- **`desktop/.../components/layout/ChatArea.tsx`**：滚动容器 `overflow-y-auto` → 加 `overflow-x-hidden` 兜底，杜绝其他意外元素（如宽表格）再撑出横向滚动条。

## 验证

- `pnpm -r typecheck` ✅。
- 冒烟清单（待 UI 实测）：
  1. 设置页添加模型下拉显示「OpenAI 兼容」，title 悬浮仍有"自填地址与 Key"说明。
  2. 聊天中粘贴三条百度百科长 URL（`https://baike.baidu.com/item/%E5%85%AC%E7%89%9B...`）→ 正文内折行显示，聊天区无横向滚动条，点击链接 href 完整。
  3. 代码块内粘贴超长行 → 不折行，代码块区域内可横向滚动，聊天区整体不动。
