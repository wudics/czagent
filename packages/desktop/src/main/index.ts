import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigStore, openDb, SessionManager, type Db } from '@czagent/core/node';
import { IPC } from '@shared/ipc';
import type { SessionEvent } from '@czagent/core';
let db: Db | null = null;
let manager: SessionManager | null = null;

/** 本地媒体协议：渲染层 <video>/<audio> 内联播放生成文件（须在 app ready 前注册特权） */
protocol.registerSchemesAsPrivileged([
  { scheme: 'czagent-file', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

/** czagent-file:///<绝对路径> → 本地文件（逐段 URL 编码由渲染层完成；Windows 盘符去掉多余前导斜杠） */
function registerLocalMediaProtocol(): void {
  protocol.handle('czagent-file', (request) => {
    try {
      let p = decodeURIComponent(new URL(request.url).pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      if (!/^([A-Za-z]:\/|\/)/.test(p)) return new Response('Bad Request', { status: 400 });
      return net.fetch(pathToFileURL(p).toString());
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

/** 外链白名单：http(s) 与 mailto 走系统默认浏览器，其余协议拒绝 */
function isExternalLink(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith('mailto:');
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0a',
    // Linux 任务栏窗口图标：dev 态取 build/，打包态取 resources/icon.png（见 electron-builder extraResources）
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // 外链一律走系统默认浏览器，禁止窗口内导航（markdown 链接 / websearch 结果等）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    // 仅拦截渲染进程发起的导航（点击链接）；应用自身的 loadURL/loadFile 不经过此处
    if (isExternalLink(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function broadcast(ev: SessionEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.event, ev);
  }
}

function registerIpc(mgr: SessionManager): void {
  ipcMain.handle(IPC.sessions.list, () => mgr.listSessions());
  ipcMain.handle(IPC.sessions.create, (_e, input) => mgr.createSession(input));
  ipcMain.handle(IPC.sessions.patch, (_e, id, patch) => mgr.patchSession(id, patch));
  ipcMain.handle(IPC.sessions.delete, (_e, id) => mgr.deleteSession(id));
  ipcMain.handle(IPC.messages.page, (_e, sessionId, opts) => mgr.getMessages(sessionId, opts));
  ipcMain.handle(IPC.messages.send, (_e, sessionId, input) => mgr.sendMessage(sessionId, input));
  ipcMain.handle(IPC.session.stop, (_e, sessionId) => mgr.stopSession(sessionId));
  ipcMain.handle(IPC.session.compact, (_e, sessionId) => mgr.compactSession(sessionId));
  ipcMain.handle(IPC.session.context, (_e, sessionId) => mgr.getSessionContext(sessionId));
  ipcMain.handle(IPC.session.usage, (_e, sessionId) => mgr.getUsage(sessionId));
  ipcMain.handle(IPC.attachments.upload, (_e, sessionId, upload) => mgr.uploadAttachment(sessionId, upload));
  ipcMain.handle(IPC.settings.get, () => mgr.getSettings());
  ipcMain.handle(IPC.settings.update, (_e, patch) => mgr.updateSettings(patch));
  ipcMain.handle(IPC.permission.resolve, (_e, request, decision) => mgr.resolvePermission(request, decision));
  ipcMain.handle(IPC.mcp.getLayers, (_e, cwd?: string) => mgr.mcpGetLayers(cwd));
  ipcMain.handle(IPC.mcp.saveGlobal, (_e, config: Record<string, unknown>) => mgr.mcpSaveGlobal(config));
  ipcMain.handle(IPC.mcp.test, (_e, cfg: unknown) => mgr.mcpTest(cfg));
  ipcMain.handle(IPC.skills.list, (_e, cwd?: string) => mgr.listSkills(cwd));
  ipcMain.handle(IPC.script.entryFile, (_e, cwd?: string) => mgr.findEntryFile(cwd));
  ipcMain.handle(IPC.question.resolve, (_e, id: string, answer: string) => mgr.resolveQuestion(id, answer));
  ipcMain.handle(IPC.todo.get, (_e, sessionId: string) => mgr.getSessionTodo(sessionId));
  ipcMain.handle(IPC.shell.openPath, (_e, p) => shell.openPath(String(p)));
  ipcMain.handle(IPC.shell.showItemInFolder, (_e, p) => {
    shell.showItemInFolder(String(p));
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerLocalMediaProtocol();

  const userData = app.getPath('userData');
  db = openDb(join(userData, 'czagent.db'));
  // 内置技能目录：开发态在源码 resources/；打包态由 electron-builder extraResources 拷到 resourcesPath/skills
  const builtinSkillsDir = app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(__dirname, '../../resources/skills');
  manager = new SessionManager({
    db,
    config: new ConfigStore(userData),
    attachmentsDir: join(userData, 'attachments'),
    builtinSkillsDir,
  });
  manager.onEvent(broadcast);
  registerIpc(manager);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (db) {
    db.sqlite.close();
    db = null;
  }
  // 尽力关闭 MCP 连接（stdio 子进程随退出回收）
  void manager?.closeMcp();
});
