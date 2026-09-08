import { create } from 'zustand';

export type AppView = 'chat' | 'settings';

interface UIState {
  view: AppView;
  openSettings(): void;
  openChat(): void;
}

export const useUIStore = create<UIState>((set) => ({
  view: 'chat',
  openSettings: () => set({ view: 'settings' }),
  openChat: () => set({ view: 'chat' }),
}));
