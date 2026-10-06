import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../database/db.js';
import { chats } from '../../database/schema.js';

const ChatShape = z.object({
  id: z.number(),
  jid: z.string(),
  displayName: z.string().nullable(),
  isGroup: z.number(),
  ignored: z.number(),
  messageCount: z.number(),
});

const PatchSchema = z.object({
  ignored: z.union([z.literal(0), z.literal(1)]),
});

/**
 * Чаты для UI-переключателя приватности (шаг 9): какие диалоги
 * исключены из AI-анализа. Текстов переписок здесь нет — только метаданные.
 */
export async function chatsRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get('/api/chats', async (req, reply) => {
    const rows = await db
      .select({
        id: chats.id,
        jid: chats.jid,
        displayName: chats.displayName,
        isGroup: chats.isGroup,
      })
      .from(chats)
      .orderBy(desc(chats.id))
      .limit(500);
    const counts = new Map<number, number>();
    for (const r of db.all<{ chat_id: number; n: number }>(
      sql`SELECT chat_id, COUNT(*) AS n FROM messages GROUP BY chat_id`,
    )) {
      counts.set(r.chat_id, r.n);
    }
    const ignored = new Map<string, number>();
    for (const r of db.all<{ chat_jid: string; ignored: number }>(
      sql`SELECT chat_jid, ignored FROM chat_settings`,
    )) {
      ignored.set(r.chat_jid, r.ignored);
    }
    const list = rows.map((r) => ({
      ...r,
      ignored: ignored.get(r.jid) ?? 0,
      messageCount: counts.get(r.id) ?? 0,
    }));
    const parsed = z.array(ChatShape).safeParse(list);
    if (!parsed.success) return reply.code(500).send({ error: 'internal contract violation' });
    return reply.send(parsed.data);
  });

  app.patch('/api/chats/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id: положительное целое' });
    const body = PatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'тело: {ignored: 0|1}' });
    const found = await db.select({ jid: chats.jid }).from(chats).where(eq(chats.id, id));
    if (found.length === 0) return reply.code(404).send({ error: 'чат не найден' });
    const now = Date.now();
    await db.run(sql`
      INSERT INTO chat_settings (chat_jid, ignored, updated_at)
      VALUES (${found[0]!.jid}, ${body.data.ignored}, ${now})
      ON CONFLICT(chat_jid) DO UPDATE SET ignored = excluded.ignored, updated_at = excluded.updated_at
    `);
    return reply.send({ id, jid: found[0]!.jid, ignored: body.data.ignored });
  });
}
