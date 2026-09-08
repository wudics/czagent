import { create } from 'zustand';
import { getProvider, type SessionEvent, type TodoItem } from '@czagent/core';

interface TodosState {
  bySession: Record<string, TodoItem[]>;
  attachEvents(): void;
  load(sessionId: string): Promise<void>;
  handleEvent(ev: SessionEvent): void;
}

export const useTodosStore = create<TodosState>((set, get) => ({
  bySession: {},

  attachEvents() {
    getProvider().onEvent((ev) => get().handleEvent(ev));
  },

  async load(sessionId) {
    const items = await window.czagent?.getSessionTodo?.(sessionId);
    if (items) set((s) => ({ bySession: { ...s.bySession, [sessionId]: items } }));
  },

  handleEvent(ev) {
    if (ev.type !== 'session.todo') return;
    set((s) => ({ bySession: { ...s.bySession, [ev.sessionId]: ev.todos } }));
  },
}));
