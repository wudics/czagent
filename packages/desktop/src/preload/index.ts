import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { SessionEvent } from '@czagent/core';
import { IPC, type IpcApi } from '@shared/ipc';

const api: IpcApi = {
  listSessions: () => ipcRenderer.invoke(IPC.sessions.list),
  createSession: (input) => ipcRenderer.invoke(IPC.sessions.create, input),
  patchSession: (id, patch) => ipcRenderer.invoke(IPC.sessions.patch, id, patch),
  deleteSession: (id) => ipcRenderer.invoke(IPC.sessions.delete, id),
  getMessages: (sessionId, opts) => ipcRenderer.invoke(IPC.messages.page, sessionId, opts),
  sendMessage: (sessionId, input) => ipcRenderer.invoke(IPC.messages.send, sessionId, input),
  stopSession: (sessionId) => ipcRenderer.invoke(IPC.session.stop, sessionId),
  compactSession: (sessionId) => ipcRenderer.invoke(IPC.session.compact, sessionId),
  getUsage: (sessionId) => ipcRenderer.invoke(IPC.session.usage, sessionId),
  uploadAttachment: (sessionId, upload) => ipcRenderer.invoke(IPC.attachments.upload, sessionId, upload),
  getSettings: () => ipcRenderer.invoke(IPC.settings.get),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settings.update, patch),
  resolvePermission: (request, decision) => ipcRenderer.invoke(IPC.permission.resolve, request, decision),
  openPath: (path: string) => ipcRenderer.invoke(IPC.shell.openPath, path),
  showItemInFolder: (path: string) => ipcRenderer.invoke(IPC.shell.showItemInFolder, path),
  mcpGetLayers: (cwd?: string) => ipcRenderer.invoke(IPC.mcp.getLayers, cwd),
  mcpSaveGlobal: (config: unknown) => ipcRenderer.invoke(IPC.mcp.saveGlobal, config),
  mcpTestConnection: (cfg: unknown) => ipcRenderer.invoke(IPC.mcp.test, cfg),
  listSkills: (cwd?: string) => ipcRenderer.invoke(IPC.skills.list, cwd),
  findEntryFile: (cwd?: string) => ipcRenderer.invoke(IPC.script.entryFile, cwd),
  resolveQuestion: (id: string, answer: string) => ipcRenderer.invoke(IPC.question.resolve, id, answer),
  getSessionTodo: (sessionId: string) => ipcRenderer.invoke(IPC.todo.get, sessionId),
  onEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, ev: SessionEvent): void => cb(ev);
    ipcRenderer.on(IPC.event, handler);
    return () => {
      ipcRenderer.removeListener(IPC.event, handler);
    };
  },
};

contextBridge.exposeInMainWorld('czagent', api);
