import type { IpcApi } from '@shared/ipc';

declare global {
  interface Window {
    /** Electron preload 暴露的 API；浏览器（dev:ui Mock）模式下不存在 */
    czagent?: IpcApi;
  }
}

export {};
