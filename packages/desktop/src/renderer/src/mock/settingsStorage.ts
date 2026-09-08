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
        cache = JSON.parse(raw) as Settings;
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
