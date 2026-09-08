import type { MessagePart, PermissionRequest, ThinkingMode } from '@czagent/core';

export interface MockModelDef {
  id: string;
  name: string;
  provider: string;
  capability: string;
}

export const MOCK_MODELS: MockModelDef[] = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', capability: 'chat' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', capability: 'chat' },
  { id: 'siliconflow-deepseek-v4', name: 'SiliconFlow DeepSeek V4', provider: 'siliconflow', capability: 'chat' },
  { id: 'agnes-2.5-flash', name: 'Agnes 2.5 Flash', provider: 'agnes', capability: 'chat' },
  { id: 'agnes-2.5-pro', name: 'Agnes 2.5 Pro', provider: 'agnes', capability: 'chat' },
];

export const MOCK_THINKING_MODES = [
  { id: 'off', label: '不思考' },
  { id: 'on', label: '思考' },
  { id: 'deep', label: '深度思考' },
] as const;

export const MOCK_CWD = 'D:\\projects\\czagent';

/**
 * 模拟流式的"阶段"计划。按阶段依次发射事件：
 *  - reasoning / text：逐段流式
 *  - tool：先 tool-call（running），可插权限询问，再 tool-result
 *  - permission：发起权限弹窗，等待用户决定后继续
 *  - error：错误 part
 */
export type StreamPhase =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; input: unknown; output: unknown; title?: string; delay?: number }
  | { kind: 'permission'; request: Omit<PermissionRequest, 'id'> }
  | { kind: 'error'; message: string };

export interface StreamScenario {
  phases: StreamPhase[];
}

export function buildScenario(
  input: string,
  thinkingMode: ThinkingMode,
): StreamScenario {
  const thinking = thinkingMode !== 'off';
  const hasThinking = thinking;

  if (/权限|允许|allow|问一下/.test(input)) {
    return {
      phases: [
        ...(hasThinking ? [{ kind: 'reasoning' as const, text: REASONING_WRITE }] : []),
        {
          kind: 'permission',
          request: { tool: 'write', args: { file: 'src/index.ts', content: '...' }, targetPath: MOCK_CWD + '\\src\\index.ts' },
        },
        { kind: 'tool', tool: 'write', input: { file: 'src/index.ts', content: '...' }, output: 'src/index.ts 写入成功（12 行）' },
        { kind: 'text', text: TEXT_PERMISSION_RESULT },
      ],
    };
  }

  if (/工具|重构|读文件|grep|glob|bash|查找|read/.test(input)) {
    return {
      phases: [
        ...(hasThinking ? [{ kind: 'reasoning' as const, text: REASONING_TOOL }] : []),
        { kind: 'tool', tool: 'grep', input: { pattern: 'TODO', include: '*.ts' }, output: 'src/app.ts:12  // TODO: 拆分模块\nsrc/utils.ts:34  // TODO: 补充单测', title: 'grep "TODO"' },
        { kind: 'tool', tool: 'glob', input: { pattern: 'src/**/*.ts' }, output: 'src/app.ts\nsrc/utils.ts\nsrc/api/client.ts' },
        { kind: 'text', text: TEXT_TOOL_RESULT },
      ],
    };
  }

  if (/错误|报错|error|失败/.test(input)) {
    return {
      phases: [
        ...(hasThinking ? [{ kind: 'reasoning' as const, text: REASONING_ERROR }] : []),
        { kind: 'error', message: '调用模型超时（请求超时 30s），建议稍后重试。' },
        { kind: 'text', text: TEXT_ERROR_RESULT },
      ],
    };
  }

  if (/长文|长文档|分页|长历史|markdown/.test(input)) {
    return {
      phases: [
        ...(hasThinking ? [{ kind: 'reasoning' as const, text: REASONING_LONG }] : []),
        { kind: 'text', text: TEXT_LONG },
      ],
    };
  }

  return {
    phases: [
      ...(hasThinking ? [{ kind: 'reasoning' as const, text: REASONING_DEFAULT }] : []),
      { kind: 'text', text: TEXT_DEFAULT },
    ],
  };
}

/** 按文本 chunk 切分（模拟 token 流） */
export function chunkText(text: string, size = 6): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

export function partFromPhase(phase: StreamPhase, index: number): { part: MessagePart; phase: StreamPhase } | null {
  switch (phase.kind) {
    case 'reasoning':
      return { part: { type: 'reasoning', text: '' }, phase };
    case 'text':
      return { part: { type: 'text', text: '' }, phase };
    case 'tool':
      return {
        part: { type: 'tool-call', tool: phase.tool, callID: `call-${index}-${Date.now()}`, input: phase.input, state: 'running', title: phase.title },
        phase,
      };
    case 'permission':
    case 'error':
      return null;
  }
}

// ---- 文案 ----

const REASONING_DEFAULT = '让我先梳理一下这个问题。用户关心的是功能可行性，我需要给出清晰的实现路径。';

const REASONING_TOOL = '这个任务需要先了解代码库现状。我应该先搜索相关代码，确认改动范围，再给出方案。';

const REASONING_WRITE = '用户要求写入文件，但目标路径可能不在会话工作目录内。我需要先确认权限，避免越权修改。';

const REASONING_ERROR = '刚刚的请求没有返回预期结果，可能是网络或服务端波动。我先说明失败原因，再给出替代方案。';

const REASONING_LONG = '这是一篇长文档。我会按主题分章节输出，保证结构清晰、便于快速浏览。';

const TEXT_DEFAULT = [
  '好的，我来详细说明这个方案。',
  '',
  '## 实现思路',
  '',
  '整体分为三层：',
  '',
  '1. **协议层**：统一把各家模型的输出归一化为 `LLMEvent` 事件流，下游不感知厂商差异。',
  '2. **会话层**：主循环消费事件流，增量持久化消息 parts，并管理上下文压缩。',
  '3. **渲染层**：只消费同一套 `SessionEvent`，实现虚拟滚动与流式渲染。',
  '',
  '```ts',
  'const events = llm.stream(request)',
  'for await (const ev of events) {',
  '  persistPart(sessionId, messageId, ev)',
  '}',
  '```',
  '',
  '这样的好处是：新增一家 OpenAI 兼容厂商时，只需要加一个 profile，协议 bug 一次修复全局生效。',
].join('\n');

const TEXT_TOOL_RESULT = [
  '根据搜索结果，当前改动点比较集中：',
  '',
  '- `src/app.ts` 有两处 TODO，涉及模块拆分',
  '- `src/api/client.ts` 是唯一的外部请求入口',
  '',
  '建议先把 `client.ts` 的请求层抽象出来，再拆分 `app.ts`。需要我直接动手改吗？',
].join('\n');

const TEXT_PERMISSION_RESULT = '文件已成功写入，路径在会话工作目录内，后续同类操作会自动放行。';

const TEXT_ERROR_RESULT = '你可以稍后重试，或换一个更稳定的模型实例（在输入框左侧切换）。';

export const TEXT_LONG = [
  '# 项目开发手册',
  '',
  '## 1. 环境准备',
  '',
  '| 工具 | 版本 | 说明 |',
  '| --- | --- | --- |',
  '| Node.js | ≥ 20 | 运行时 |',
  '| pnpm | ≥ 9 | 包管理 |',
  '| Electron | 44.x | 桌面壳 |',
  '',
  '## 2. 常用命令',
  '',
  '```bash',
  'pnpm dev       # 启动 Electron（真实 IPC 链路）',
  'pnpm dev:ui    # 浏览器 Mock 模式（本迭代体验入口）',
  'pnpm typecheck # 全量类型检查',
  'pnpm test      # 单元测试',
  '```',
  '',
  '## 3. 目录结构',
  '',
  '```text',
  'packages/',
  '  core/     # agent 引擎（纯 Node，无 Electron 依赖）',
  '  desktop/  # electron-vite 三端（main/preload/renderer）',
  '```',
  '',
  '## 4. 设计原则',
  '',
  '- **统一事件流**：所有能力最终收敛为 `LLMEvent`，下游无感知。',
  '- **增量持久化**：流式过程中每个 part 增量落库，窗口刷新即得最新状态。',
  '- **Provider 抽象缝**：UI 与 core 解耦，界面可脱离后端先用 Mock 跑。',
  '',
  '> 本文档由 Mock 场景生成，用于演示长文档流式渲染与滚动跟随效果。',
  '',
  '## 5. 后续迭代',
  '',
  'I1 → I2 → I3 → I4 → I5 → I6 → P2，每轮交付都可直接运行体验。',
].join('\n');

/** 用于分页演示的历史消息模板 */
export const HISTORY_USER_PROMPTS = [
  '这个功能怎么设计比较好？',
  '帮我重构一下这段代码',
  '分析一下当前目录结构',
  '给这个模块补充单元测试',
  '解释一下这条报错的原因',
  '优化一下这段 SQL 的性能',
  '写一个 README 模板',
  '这个 API 的鉴权流程是什么？',
  '把注释翻译成中文',
  '总结一下这个项目的架构',
];

export function historyAssistantParts(i: number): MessagePart[] {
  const t = i % 4;
  if (t === 0) {
    return [
      {
        type: 'reasoning',
        text: `第 ${i} 轮：先分析需求，再给出方案。`,
      },
      { type: 'text', text: `方案 ${i}：建议分为三步实现，先做基础封装，再做业务层，最后加测试。\n\n- 步骤一：定义接口\n- 步骤二：实现逻辑\n- 步骤三：补充用例` },
    ];
  }
  if (t === 1) {
    return [
      {
        type: 'tool-call',
        tool: 'grep',
        callID: `hist-${i}-1`,
        input: { pattern: 'TODO', include: '*.ts' },
        state: 'completed',
        title: 'grep TODO',
      },
      {
        type: 'tool-result',
        callID: `hist-${i}-1`,
        output: `src/app.ts:${10 + i} // TODO: 待拆分\nsrc/utils.ts:${i} // TODO: 补充单测`,
        state: 'completed',
      },
      { type: 'text', text: `找到 ${2 + (i % 3)} 处 TODO，其中两处与本次需求相关。` },
    ];
  }
  if (t === 2) {
    return [
      { type: 'error', message: `第 ${i} 轮请求超时（30s），已自动重试。` },
      { type: 'text', text: `重试成功，以下是结果：模型返回正常。` },
    ];
  }
  return [
    { type: 'text', text: `历史消息 ${i}：这是用于演示"向上滚动分页加载 + 向下滚动释放资源"的填充内容，包含**加粗**、\`行内代码\` 与列表。\n\n- 条目 A\n- 条目 B\n- 条目 C` },
  ];
}

export const HISTORY_ASSISTANT_PROMPT_SUFFIX = '（历史填充消息）';
