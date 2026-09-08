import type { PermissionDecision, PermissionRequest, Settings } from '../provider.js';

export interface ToolContext {
  sessionId: string;
  cwd: string;
  settings: Settings;
  signal: AbortSignal;
  /** 会话临时目录根（webfetch 等大结果落盘用；会话删除时整体清理） */
  tempDir?: string;
  /** 内置技能目录根（skill 工具发现用；由主进程注入打包资源） */
  builtinSkillsDir?: string;
  /** 工具执行进度上报（更新当前工具卡片标题；长任务如视频生成轮询用） */
  reportProgress?: (text: string) => void;
  /** 切换会话 agent（plan-exit 用；由 SessionManager 注入） */
  setAgent?: (agentId: string) => Promise<void>;
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
