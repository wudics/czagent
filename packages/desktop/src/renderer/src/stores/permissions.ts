import { create } from 'zustand';
import {
  getProvider,
  type PermissionDecision,
  type PermissionRequest,
  type SessionEvent,
} from '@czagent/core';

export interface PendingPermission {
  sessionId: string;
  request: PermissionRequest;
}

interface PermissionsState {
  /** 全部待批权限请求（按会话隔离，互不覆盖；修复并发下全局弹窗互相顶掉的问题） */
  pending: PendingPermission[];
  attachEvents(): void;
  resolve(item: PendingPermission, decision: PermissionDecision): Promise<void>;
  handleEvent(ev: SessionEvent): void;
}

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
  pending: [],

  attachEvents() {
    getProvider().onEvent((ev) => get().handleEvent(ev));
  },

  async resolve(item, decision) {
    await getProvider().resolvePermission(item.request, decision);
    set((s) => ({ pending: s.pending.filter((p) => p.request.id !== item.request.id) }));
  },

  handleEvent(ev) {
    if (ev.type !== 'permission.request') return;
    set((s) => {
      if (s.pending.some((p) => p.request.id === ev.request.id)) return s;
      return { pending: [...s.pending, { sessionId: ev.sessionId, request: ev.request }] };
    });
  },
}));
