import type { AgentProvider, McpLayers, SkillMeta, TodoItem } from '@czagent/core';

export const IPC = {
  sessions: {
    list: 'sessions:list',
    create: 'sessions:create',
    patch: 'sessions:patch',
    delete: 'sessions:delete',
  },
  messages: {
    page: 'messages:page',
    send: 'messages:send',
  },
  session: {
    stop: 'session:stop',
    usage: 'session:usage',
    compact: 'session:compact',
  },
  todo: {
    get: 'todo:get',
  },
  question: {
    resolve: 'question:resolve',
  },
  attachments: {
    upload: 'attachments:upload',
  },
  script: {
    entryFile: 'script:entryFile',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
  },
  permission: {
    resolve: 'permission:resolve',
  },
  mcp: {
    getLayers: 'mcp:getLayers',
    saveGlobal: 'mcp:saveGlobal',
    test: 'mcp:test',
  },
  skills: {
    list: 'skills:list',
  },
  shell: {
    openPath: 'shell:openPath',
    showItemInFolder: 'shell:showItemInFolder',
  },
  /** main → renderer 流式事件推送 */
  event: 'session:event',
} as const;

/** preload 暴露给渲染层的 API（AgentProvider 契约 + 桌面能力） */
export type IpcApi = AgentProvider & {
  /** 用系统资源管理器打开目录 */
  openPath: (path: string) => Promise<string>;
  /** 在资源管理器中定位文件/目录 */
  showItemInFolder: (path: string) => Promise<void>;
  /** 设置页 MCP Tab：读取两层配置（含来源标记；cwd 决定工作区层） */
  mcpGetLayers: (cwd?: string) => Promise<McpLayers>;
  /** 设置页 MCP Tab：保存全局层配置（工作区层不受影响） */
  mcpSaveGlobal: (config: unknown) => Promise<void>;
  /** 设置页 MCP Tab：连接测试（返回工具清单或错误） */
  mcpTestConnection: (cfg: unknown) => Promise<{ ok: boolean; tools: string[]; error?: string }>;
  /** 设置页技能 Tab / Agent 编辑：技能列表（cwd 可选，提供则含工作区层） */
  listSkills: (cwd?: string) => Promise<SkillMeta[]>;
  /** 探测工作目录入口脚本路径（无入口返回 null） */
  findEntryFile: (cwd?: string) => Promise<string | null>;
  /** 用户回答 question 提问（界面作答回传核心） */
  resolveQuestion: (id: string, answer: string) => Promise<void>;
  /** 读取会话任务清单 */
  getSessionTodo: (sessionId: string) => Promise<TodoItem[]>;
};
