import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { Storage } from './repo.js';

export interface Db {
  sqlite: Database.Database;
  drizzle: BetterSQLite3Database<typeof schema>;
  storage: Storage;
}

export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(schema.SCHEMA_DDL);
  migrate(sqlite);
  const drizzleDb = drizzle(sqlite, { schema });
  return { sqlite, drizzle: drizzleDb, storage: new Storage(drizzleDb) };
}

/** 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给旧表补列，这里按需 ALTER */
function migrate(sqlite: Database.Database): void {
  const cols = sqlite.pragma('table_info(sessions)') as { name: string }[];
  if (!cols.some((c) => c.name === 'title_source')) {
    // 历史会话一律视为用户自定义标题（默认 'user'），绝不被自动生成覆盖
    sqlite.exec("ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'user'");
  }
  if (!cols.some((c) => c.name === 'web_access')) {
    // 联网开关（I16）：历史会话默认开（1）；0 = 禁用 webfetch/websearch
    sqlite.exec("ALTER TABLE sessions ADD COLUMN web_access INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.some((c) => c.name === 'todo')) {
    // todo 工具清单（I18 持久化）：历史会话默认 NULL = 未建立，重启后由面板按需恢复
    sqlite.exec("ALTER TABLE sessions ADD COLUMN todo TEXT");
  }
}

export function closeDb(db: Db): void {
  try {
    db.sqlite.close();
  } catch {
    // ignore
  }
}
