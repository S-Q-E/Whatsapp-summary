import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DigestService } from '../../digest/service.js';

/** Минимальный интерфейс для routes (в тестах — stub). */
export type DigestController = {
  preview: () => { dateIso: string; content: string };
  sendToday: (
    reason: string,
    opts?: { force?: boolean; resend?: boolean; nowMs?: number },
  ) => Promise<{ sent: boolean; reason: string; dateIso: string }>;
};

const ConfirmSchema = z.object({
  confirm: z.literal(true, { error: 'нужно тело {"confirm": true}' }),
});

export async function digestRoutes(app: FastifyInstance, svc: DigestController): Promise<void> {
  // Текст без отправки и без записи (предпросмотр в UI).
  app.post('/api/digest/preview', async (_req, reply) => {
    return reply.send(svc.preview());
  });

  // Кнопка «Отправить сейчас» (с подтверждением): обходит проверку времени,
  // но НЕ already-sent без явного resend. Та же идемпотентность, что у планировщика.
  app.post('/api/digest/send-now', async (req, reply) => {
    const body = ConfirmSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'нужно тело {"confirm": true}' });
    }
    const res = await svc.sendToday('manual', { force: true });
    return reply.send(res);
  });
}

export type { DigestService };
