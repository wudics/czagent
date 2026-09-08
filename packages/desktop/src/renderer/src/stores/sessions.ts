import { create } from 'zustand';
import { getProvider, type CreateSessionInput, type SessionEvent, type SessionMeta, type SessionPatch } from '@czagent/core';

interface SessionsState {
  sessions: SessionMeta[];
  activeId: string | null;
  initialized: boolean;
  init(): Promise<void>;
  attachEvents(): void;
  select(id: string): void;
  create(input: CreateSessionInput): Promise<void>;
  remove(id: string): Promise<void>;
  patch(id: string, patch: SessionPatch): Promise<void>;
  applyEvent(ev: SessionEvent): void;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeId: null,
  initialized: false,

  async init() {
    const sessions = await getProvider().listSessions();
    set({ sessions, initialized: true });
    if (!get().activeId && sessions.length > 0) set({ activeId: sessions[0]!.id });
  },

  attachEvents() {
    getProvider().onEvent((ev) => get().applyEvent(ev));
  },

  applyEvent(ev) {
    if (ev.type === 'session.updated') {
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === ev.sessionId ? ev.meta : x)) }));
    } else if (ev.type === 'session.status') {
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === ev.sessionId ? { ...x, status: ev.status } : x)),
      }));
    }
  },

  select(id) {
    set({ activeId: id });
  },

  async create(input) {
    const meta = await getProvider().createSession(input);
    set((s) => ({ sessions: [meta, ...s.sessions], activeId: meta.id }));
  },

  async remove(id) {
    await getProvider().deleteSession(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      return {
        sessions,
        activeId: s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId,
      };
    });
  },

  async patch(id, patch) {
    const meta = await getProvider().patchSession(id, patch);
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? meta : x)) }));
  },
}));
