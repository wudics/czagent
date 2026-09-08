/** 脚本编排（I7 起，I14.1 子进程化；I18 ctx 增强）：ctx 桥契约与运行选项。 */
import type { GeneralSettings } from '../provider.js';

export interface ScriptAgentRunOptions {
  /** 子运行使用的模型 id（默认会话模型） */
  model?: string;
  /** 委派的 agent id（默认 build；plan → 只读工具集） */
  agent?: string;
  /** 工具绑定：传则覆盖 agent 默认；未知 id 忽略；内部工具（plan/plan-exit）永远排除；
   *  可包含内置工具 id（如 'skill'）与 MCP 工具 id（需配合 mcpServers） */
  tools?: string[];
  /** 步数上限：覆盖 agent 定义中的 steps；0/缺省 = 跟随 agent（留空=不限） */
  maxSteps?: number;
  /** MCP 服务器名单：显式传入时并入这些服务器的工具（与 agent 生效名单取交集），
   *  不再要求"不传 tools 白名单"这一前置条件；缺省 = 维持旧行为（仅全开 agent 且未传 tools 时并入） */
  mcpServers?: string[];
}

/** ctx.* 跨进程请求（child → main），由 SessionManager 落回权限管线/子代理/日志 */
export interface ChildRunHandlers {
  /** ctx.tools.<id>(input, {timeoutMs})：主进程做权限判定与工具卡片；抛错 → 子进程侧 reject */
  onTool(tool: string, input: unknown, timeoutMs?: number): Promise<unknown>;
  /** ctx.agent.run(prompt, opts)：主进程 runSubAgent（进度流入会话消息） */
  onAgentRun(prompt: string, opts?: ScriptAgentRunOptions): Promise<string>;
  /** ctx.log / console.* → 会话日志流 */
  onLog(line: string): void;
  /** ctx.ask({tool,args}) → 权限卡；返回决定字符串 */
  onAsk(tool: string, args: unknown): Promise<string>;
}

export interface ChildRunOptions {
  /** 入口脚本绝对路径（每次运行实时读盘 bundle） */
  entryPath: string;
  /** 子进程工作目录与 esbuild 解析根 */
  cwd: string;
  /** 临时 bundle 输出目录（由调用方创建） */
  runDir: string;
  /** 注入 ctx.session */
  sessionMeta: { id: string; cwd: string; model: string; mode: string };
  /** 注入 ctx.settings（general 只读快照；跨进程序列化后脚本无法改动宿主配置） */
  settingsGeneral: GeneralSettings;
  /** 0/缺省 = 不限；>0 到期 kill（abort 帧 + 5s 宽限 → SIGKILL） */
  timeoutMs?: number;
  /** 外部停止信号：发 abort 帧，宽限后 kill */
  signal?: AbortSignal;
  handlers: ChildRunHandlers;
}
