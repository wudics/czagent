import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../provider.js';
import { createDefaultSettings, DEFAULT_BINDINGS, DEFAULT_PERMISSIONS, mergeSettings } from '../settings-defaults.js';

const CONFIG_FILE = 'config.json';

/**
 * 设置持久化（决策 10）：userData/config.json。
 * 读取时与内置默认做合并，保证字段齐全；缺失文件时写入默认。
 * 兼容旧配置：默认能力绑定/权限规则只追加缺失项；builtin plan agent 补齐 plan 工具，均不覆盖用户已选值。
 */
export class ConfigStore {
  constructor(private readonly dir: string) {}

  private filePath(): string {
    return join(this.dir, CONFIG_FILE);
  }

  async read(): Promise<Settings> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as Settings;
      const merged = mergeSettings(createDefaultSettings(), parsed);
      // 旧配置迁移：确保每个默认能力绑定存在（保留用户已选值）
      const bindings = [...merged.bindings];
      for (const b of DEFAULT_BINDINGS) {
        if (!bindings.some((x) => x.capability === b.capability)) bindings.push({ ...b });
      }
      // 旧配置迁移：确保每个默认权限规则存在（保留用户已改的模式）
      const rules = [...merged.permissions.default];
      for (const r of DEFAULT_PERMISSIONS.default) {
        if (!rules.some((x) => x.tool === r.tool)) rules.push({ ...r });
      }
      // 旧配置迁移：builtin plan agent 补齐内部工具（幂等；不影响自定义 agent）
      const agents = merged.agents.map((a) =>
        a.id === 'plan' && a.builtin
          ? { ...a, tools: [...new Set([...a.tools, 'plan', 'plan-exit'])] }
          : a,
      );
      return { ...merged, bindings, permissions: { default: rules }, agents };
    } catch {
      const defaults = createDefaultSettings();
      await this.write(defaults);
      return defaults;
    }
  }

  async write(settings: Settings): Promise<Settings> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(), JSON.stringify(settings, null, 2), 'utf8');
    return settings;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.read();
    const next = mergeSettings(current, patch);
    await this.write(next);
    return next;
  }
}
