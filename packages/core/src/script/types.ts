/** 脚本编排（I7 起，I14.1 子进程化；I18 ctx 增强）：ctx 桥契约与运行选项。 */
import type { GeneralSettings } from '../provider.js';

export interface ScriptAgentRunOptions {
  /** 子运行使用的模型 id（默认会话模型） */
  model?: string;
  /** 委派的 agent：id 或 name 均可（如 'plan' / '猛男村村长'；I19）；缺省 = build；找不到抛错 */
  agent?: string;
  /** 工具绑定：传则覆盖 agent 默认；未知 id 忽略；内部工具（plan/plan-exit）永远排除；
   *  可包含内置工具 id（如 'skill'）与 MCP 工具 id（需配合 mcpServers） */
  tools?: string[];
  /** 步数上限：覆盖 agent 定义中的 steps；0/缺省 = 跟随 agent（留空=不限） */
  maxSteps?: number;
  /** MCP 服务器名单（I19 权威覆盖）：显式传入即按此名单取工具（仅限 mcp.json 已配置的服务器，未知名忽略），
   *  不再与 agent 生效名单取交集；缺省 = 按 agent 的 MCP 三态设置（跟随全局/强制开/排除） */
  mcpServers?: string[];
  /** 技能白名单（I19）：显式传入即按此名单过滤（权威覆盖全局 disabledSkills 与 agent skillOverrides），
   *  该次子代理的 skill 工具只认名单内技能；缺省 = 跟随全局设置 */
  skills?: string[];
}

/** ctx.use 覆盖项（I19）：undefined=不修改；null=清除覆盖（回到 agent/全局设置）；数组=权威名单（空数组=全关） */
export interface ScriptUseOverrides {
  mcpServers?: string[] | null;
  skills?: string[] | null;
}

/** ctx.* 跨进程请求（child → main），由 SessionManager 落回权限管线/子代理/日志 */
export interface ChildRunHandlers {
  /** ctx.tools.<id>(input, {timeoutMs})：主进程做权限判定与工具卡片；抛错 → 子进程侧 reject */
  onTool(tool: string, input: unknown, timeoutMs?: number): Promise<unknown>;
  /** ctx.agent.run(prompt, opts)：主进程 runSubAgent（进度流入会话消息） */
  onAgentRun(prompt: string, opts?: ScriptAgentRunOptions): Promise<string>;
  /** ctx.use(patch)：设置脚本自身后续 ctx.tools.* 直调的 MCP/skill 覆盖（I19） */
  onUse(patch: ScriptUseOverrides): void;
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
