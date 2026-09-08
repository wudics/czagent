import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const sessionsTable = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  mode: text('mode').notNull(),
  agentId: text('agent_id').notNull(),
  cwd: text('cwd').notNull(),
  modelId: text('model_id').notNull(),
  thinkingMode: text('thinking_mode').notNull(),
  status: text('status').notNull(),
  webAccess: integer('web_access').notNull().default(1),
  titleSource: text('title_source').notNull().default('user'),
  /** todo 工具清单（TodoItem[] 的 JSON 文本；NULL/空 = 未建立） */
  todo: text('todo'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const messagesTable = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  role: text('role').notNull(),
  parts: text('parts').notNull(),
  tokens: text('tokens'),
  cost: real('cost'),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
});

export const usageTable = sqliteTable('session_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  modelId: text('model_id').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  cost: real('cost').notNull().default(0),
  countedAt: integer('counted_at').notNull(),
});

export const attachmentsTable = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  messageId: text('message_id'),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  size: integer('size').notNull(),
  storedPath: text('stored_path').notNull(),
  inline: integer('inline').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model_id TEXT NOT NULL,
  thinking_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  web_access INTEGER NOT NULL DEFAULT 1,
  title_source TEXT NOT NULL DEFAULT 'user',
  todo TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  tokens TEXT,
  cost REAL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at, id);

CREATE TABLE IF NOT EXISTS session_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  counted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON session_usage(session_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  inline INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
`;
