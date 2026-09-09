import { createDefaultSettings, mergeSettings, type Settings } from '@czagent/core';

const STORAGE_KEY = 'czagent.settings.v1';

let cache: Settings | null = null;

function isLocalStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function loadSettings(): Settings {
  if (cache) return cache;
  if (isLocalStorageAvailable()) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Settings> & { providers?: unknown; models?: unknown };
        // 旧结构（providers/models）不兼容新模型为中心的结构：模型配置重置为空
        if (Array.isArray(parsed.providers) || Array.isArray(parsed.models)) {
          cache = createDefaultSettings();
          return cache;
        }
        cache = mergeSettings(createDefaultSettings(), parsed);
        return cache;
      }
    } catch {
      // 解析失败则回退默认
    }
  }
  cache = createDefaultSettings();
  return cache;
}

export function saveSettings(settings: Settings): Settings {
  cache = settings;
  if (isLocalStorageAvailable()) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // 忽略写入失败（如隐私模式）
    }
  }
  return settings;
}

export function resetSettings(): Settings {
  return saveSettings(createDefaultSettings());
}
