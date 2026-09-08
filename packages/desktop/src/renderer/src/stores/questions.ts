import { create } from 'zustand';
import { getProvider, type QuestionRequest, type SessionEvent } from '@czagent/core';

export interface PendingQuestion {
  sessionId: string;
  request: QuestionRequest;
}

interface QuestionsState {
  pending: PendingQuestion[];
  attachEvents(): void;
  answer(item: PendingQuestion, answer: string): Promise<void>;
  handleEvent(ev: SessionEvent): void;
}

export const useQuestionsStore = create<QuestionsState>((set, get) => ({
  pending: [],

  attachEvents() {
    getProvider().onEvent((ev) => get().handleEvent(ev));
  },

  async answer(item, answer) {
    await window.czagent?.resolveQuestion?.(item.request.id, answer);
    set((s) => ({ pending: s.pending.filter((p) => p.request.id !== item.request.id) }));
  },

  handleEvent(ev) {
    if (ev.type !== 'session.question') return;
    set((s) => {
      if (s.pending.some((p) => p.request.id === ev.request.id)) return s;
      return { pending: [...s.pending, { sessionId: ev.sessionId, request: ev.request }] };
    });
  },
}));
