import type { PermissionDecision, PermissionRequest, Settings } from '../provider.js';
import type { Gateway } from '../llm/gateway.js';

/** 用户在工具内部询问（ctx.ask）中选择拒绝：runLoop 识别后终止本轮（对齐 opencode 拒绝即停） */
export class UserRejectedError extends Error {
  constructor(message = '用户拒绝了本次操作') {
    super(message);
    this.name = 'UserRejectedError';
  }
}

export interface ToolContext {
  sessionId: string;
  cwd: string;
  settings: Settings;
  /** LLM 网关：多模态能力调用统一入口（embed/图像/视频/TTS/ASR 等，内含绑定解析与校验） */
  gateway: Gateway;
  signal: AbortSignal;
  /** 会话临时目录根（webfetch 等大结果落盘用；会话删除时整体清理） */
  tempDir?: string;
  /** 内置技能目录根（skill 工具发现用；由主进程注入打包资源） */
  builtinSkillsDir?: string;
  /** 技能白名单（I19）：传入时 skill 工具只认名单内技能（脚本 ctx.use / ctx.agent.run skills 的权威覆盖）；
   *  缺省 = 跟随全局 disabledSkills 过滤 */
  allowedSkills?: string[];
  /** 工具执行进度上报（更新当前工具卡片标题；长任务如视频生成轮询用） */
  reportProgress?: (text: string) => void;
  /** 切换会话 agent（plan-exit 用；由 SessionManager 注入） */
  setAgent?: (agentId: string) => Promise<void>;
  /** 缓存 plan 工具提交的计划文本（模式切换提醒锚定用；由 SessionManager 注入） */
  savePlan?: (plan: string) => void;
  /** 读取 plan 工具最近提交的计划文本（plan-exit 确认卡预览用；由 SessionManager 注入） */
  lastPlan?: () => string | undefined;
  /** 发起权限询问（返回用户决定） */
  ask(req: Omit<PermissionRequest, 'id'>): Promise<PermissionDecision>;
  /** 向用户提问并等待文本回答（question 工具；缺省 = 不支持 → 返回空） */
  askUser?(q: { question: string; options?: string[] }): Promise<string>;
  /** 管理会话任务清单（todo 工具）；返回供模型读的清单文本 */
  todo?(input: { todos?: string[]; statuses?: Record<string, 'pending' | 'in_progress' | 'completed'> }): Promise<string>;
  /** 派生子代理并返回其最终文本（task 工具；仅主会话注入，子代理内不可再派生） */
  runAgent?(prompt: string, opts?: { agentId?: string }): Promise<string>;
}

export interface ToolDef {
  id: string;
  description: string;
  /** JSON Schema */
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}
