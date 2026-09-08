import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import type { ChatMessage, MessagePage, MessagePart, SessionMeta, SessionPatch, TodoItem, Usage, Attachment } from '../provider.js';

function rowToSession(row: typeof schema.sessionsTable.$inferSelect): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as SessionMeta['mode'],
    agentId: row.agentId,
    cwd: row.cwd,
    modelId: row.modelId,
    thinkingMode: row.thinkingMode as SessionMeta['thinkingMode'],
    status: row.status as SessionMeta['status'],
    webAccess: row.webAccess !== 0,
    titleSource: (row.titleSource ?? 'user') as SessionMeta['titleSource'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToMessage(row: typeof schema.messagesTable.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as ChatMessage['role'],
    parts: (JSON.parse(row.parts) as MessagePart[]),
    tokens: row.tokens ? (JSON.parse(row.tokens) as Usage) : undefined,
    cost: row.cost ?? undefined,
    createdAt: row.createdAt,
  };
}

export class Storage {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  // ---- sessions ----

  listSessions(): SessionMeta[] {
    const rows = this.db.select().from(schema.sessionsTable).orderBy(desc(schema.sessionsTable.updatedAt)).all();
    return rows.map(rowToSession);
  }

  getSession(id: string): SessionMeta | undefined {
    const row = this.db.select().from(schema.sessionsTable).where(eq(schema.sessionsTable.id, id)).get();
    return row ? rowToSession(row) : undefined;
  }

  insertSession(meta: SessionMeta, titleSource: 'auto' | 'user' = 'user'): void {
    this.db
      .insert(schema.sessionsTable)
      .values({
        id: meta.id,
        title: meta.title,
        mode: meta.mode,
        agentId: meta.agentId,
        cwd: meta.cwd,
        modelId: meta.modelId,
        thinkingMode: meta.thinkingMode,
        status: meta.status,
        webAccess: meta.webAccess === false ? 0 : 1,
        titleSource,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      })
      .run();
  }

  patchSession(id: string, patch: SessionPatch, updatedAt: number, titleSource?: 'auto' | 'user'): SessionMeta {
    const cur = this.getSession(id);
    if (!cur) throw new Error(`session not found: ${id}`);
    const next: SessionMeta = { ...cur, ...patch, updatedAt };
    this.db
      .update(schema.sessionsTable)
      .set({
        title: next.title,
        mode: next.mode,
        agentId: next.agentId,
        modelId: next.modelId,
        thinkingMode: next.thinkingMode,
        webAccess: next.webAccess === false ? 0 : 1,
        ...(titleSource !== undefined ? { titleSource } : {}),
        updatedAt: next.updatedAt,
      })
      .where(eq(schema.sessionsTable.id, id))
      .run();
    return next;
  }

  updateSessionStatus(id: string, status: SessionMeta['status']): void {
    this.db.update(schema.sessionsTable).set({ status, updatedAt: Date.now() }).where(eq(schema.sessionsTable.id, id)).run();
  }

  // ---- session todo（I18 持久化：todo 工具清单存 sessions.todo JSON 列） ----

  /** 保存会话 todo 清单；items 为空时清空为 NULL（未建立） */
  updateSessionTodo(sessionId: string, items: TodoItem[]): void {
    const json = items.length > 0 ? JSON.stringify(items) : null;
    this.db.update(schema.sessionsTable).set({ todo: json }).where(eq(schema.sessionsTable.id, sessionId)).run();
  }

  /** 读取会话 todo 清单；无记录/解析失败/结构非法一律返回 [] */
  getSessionTodo(sessionId: string): TodoItem[] {
    const row = this.db
      .select({ todo: schema.sessionsTable.todo })
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, sessionId))
      .get();
    if (!row?.todo) return [];
    try {
      const parsed: unknown = JSON.parse(row.todo);
      if (!Array.isArray(parsed)) return [];
      const statuses = new Set(['pending', 'in_progress', 'completed']);
      return parsed.filter(
        (x): x is TodoItem =>
          !!x && typeof x === 'object' && typeof (x as TodoItem).text === 'string' && statuses.has((x as TodoItem).status),
      );
    } catch {
      return [];
    }
  }

  deleteSession(id: string): void {
    this.db.delete(schema.messagesTable).where(eq(schema.messagesTable.sessionId, id)).run();
    this.db.delete(schema.usageTable).where(eq(schema.usageTable.sessionId, id)).run();
    this.db.delete(schema.attachmentsTable).where(eq(schema.attachmentsTable.sessionId, id)).run();
    this.db.delete(schema.sessionsTable).where(eq(schema.sessionsTable.id, id)).run();
  }

  // ---- attachments ----

  insertAttachment(a: Attachment): void {
    this.db
      .insert(schema.attachmentsTable)
      .values({
        id: a.id,
        sessionId: a.sessionId,
        messageId: a.messageId ?? null,
        name: a.name,
        kind: a.kind,
        size: a.size,
        storedPath: a.storedPath,
        inline: a.inline ? 1 : 0,
        createdAt: a.createdAt,
      })
      .run();
  }

  getAttachment(id: string): Attachment | undefined {
    const row = this.db.select().from(schema.attachmentsTable).where(eq(schema.attachmentsTable.id, id)).get();
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.sessionId,
      messageId: row.messageId ?? undefined,
      name: row.name,
      kind: row.kind,
      size: row.size,
      storedPath: row.storedPath,
      inline: row.inline === 1,
      createdAt: row.createdAt,
    };
  }

  listAttachments(sessionId: string): Attachment[] {
    return this.db
      .select()
      .from(schema.attachmentsTable)
      .where(eq(schema.attachmentsTable.sessionId, sessionId))
      .all()
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        messageId: row.messageId ?? undefined,
        name: row.name,
        kind: row.kind,
        size: row.size,
        storedPath: row.storedPath,
        inline: row.inline === 1,
        createdAt: row.createdAt,
      }));
  }

  updateAttachmentMessage(id: string, messageId: string): void {
    this.db.update(schema.attachmentsTable).set({ messageId }).where(eq(schema.attachmentsTable.id, id)).run();
  }

  updateAttachmentInline(id: string, inline: boolean): void {
    this.db.update(schema.attachmentsTable).set({ inline: inline ? 1 : 0 }).where(eq(schema.attachmentsTable.id, id)).run();
  }

  deleteAttachmentsForSession(sessionId: string): void {
    this.db.delete(schema.attachmentsTable).where(eq(schema.attachmentsTable.sessionId, sessionId)).run();
  }

  // ---- messages ----

  insertMessage(msg: ChatMessage): void {
    this.db
      .insert(schema.messagesTable)
      .values({
        id: msg.id,
        sessionId: msg.sessionId,
        role: msg.role,
        parts: JSON.stringify(msg.parts),
        tokens: msg.tokens ? JSON.stringify(msg.tokens) : null,
        cost: msg.cost ?? null,
        createdAt: msg.createdAt,
      })
      .run();
  }

  updateMessageParts(id: string, parts: MessagePart[]): void {
    this.db.update(schema.messagesTable).set({ parts: JSON.stringify(parts) }).where(eq(schema.messagesTable.id, id)).run();
  }

  finalizeMessage(id: string, msg: ChatMessage): void {
    this.db
      .update(schema.messagesTable)
      .set({
        parts: JSON.stringify(msg.parts),
        tokens: msg.tokens ? JSON.stringify(msg.tokens) : null,
        cost: msg.cost ?? null,
      })
      .where(eq(schema.messagesTable.id, id))
      .run();
  }

  /** 插入或更新（错误路径可能未先 insert） */
  upsertMessage(msg: ChatMessage): void {
    this.db.run(sql`
      INSERT INTO messages (id, session_id, role, parts, tokens, cost, error, created_at)
      VALUES (${msg.id}, ${msg.sessionId}, ${msg.role}, ${JSON.stringify(msg.parts)}, ${msg.tokens ? JSON.stringify(msg.tokens) : null}, ${msg.cost ?? null}, NULL, ${msg.createdAt})
      ON CONFLICT(id) DO UPDATE SET parts = excluded.parts, tokens = excluded.tokens, cost = excluded.cost
    `);
  }

  pageMessages(sessionId: string, beforeId: string | undefined, limit: number): MessagePage {
    let anchor: { createdAt: number; id: string } | undefined;
    if (beforeId) {
      const a = this.db
        .select({ createdAt: schema.messagesTable.createdAt, id: schema.messagesTable.id })
        .from(schema.messagesTable)
        .where(eq(schema.messagesTable.id, beforeId))
        .get();
      if (a) anchor = a;
    }
    const cond = anchor
      ? and(
          eq(schema.messagesTable.sessionId, sessionId),
          or(
            lt(schema.messagesTable.createdAt, anchor.createdAt),
            and(eq(schema.messagesTable.createdAt, anchor.createdAt), lt(schema.messagesTable.id, anchor.id)),
          ),
        )
      : eq(schema.messagesTable.sessionId, sessionId);

    const rows = this.db
      .select()
      .from(schema.messagesTable)
      .where(cond)
      .orderBy(desc(schema.messagesTable.createdAt), desc(schema.messagesTable.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse().map(rowToMessage);
    return {
      messages: page,
      hasMore,
      beforeId: page[0]?.id,
    };
  }

  // ---- usage ----

  appendUsage(sessionId: string, modelId: string, usage: Usage): void {
    this.db
      .insert(schema.usageTable)
      .values({
        sessionId,
        modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cost: usage.cost,
        countedAt: Date.now(),
      })
      .run();
  }

  getUsage(sessionId: string): Usage | null {
    const rows = this.db
      .select({
        inputTokens: schema.usageTable.inputTokens,
        outputTokens: schema.usageTable.outputTokens,
        reasoningTokens: schema.usageTable.reasoningTokens,
        cacheReadTokens: schema.usageTable.cacheReadTokens,
        cacheWriteTokens: schema.usageTable.cacheWriteTokens,
        cost: schema.usageTable.cost,
      })
      .from(schema.usageTable)
      .where(eq(schema.usageTable.sessionId, sessionId))
      .all();
    if (rows.length === 0) return null;
    const sum = rows.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        reasoningTokens: acc.reasoningTokens + r.reasoningTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
        cost: acc.cost + r.cost,
      }),
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    );
    return sum;
  }
}
