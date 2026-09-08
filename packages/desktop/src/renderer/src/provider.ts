import type { AgentProvider } from '@czagent/core';
import { setProvider } from '@czagent/core';
import { createMockProvider } from './mock/mockProvider';

let initialized = false;

/**
 * 初始化 Provider 注入（决策 #25）。
 * Electron：preload 暴露完整 AgentProvider → 使用真实实现（sqlite + 主进程引擎）。
 * 浏览器（dev:ui）：无 czagent API → 使用 MockProvider。
 */
export function ensureProvider(): void {
  if (initialized) return;
  initialized = true;
  const real = typeof window !== 'undefined' ? window.czagent : undefined;
  if (real && typeof real.sendMessage === 'function') {
    setProvider(real as AgentProvider);
  } else {
    setProvider(createMockProvider());
  }
}

