import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QrEvent } from '../../whatsapp/manager.js';
import type { StatusSnapshot } from '../../whatsapp/status-store.js';

/**
 * Минимальный интерфейс, нужный routes. WhatsAppManager его реализует;
 * в тестах подставляется stub — HTTP-слой проверяется через app.inject
 * без живого сокета.
 */
export type WhatsAppController = {
  snapshot(): StatusSnapshot;
  qrSnapshot(): { qr: string | null; updatedAt: number | null };
  on(event: 'qr' | 'status', cb: (data: QrEvent | StatusSnapshot) => void): () => void;
  disconnect(): StatusSnapshot;
  connect(): Promise<StatusSnapshot>;
};

const StatusSchema = z.object({
  status: z.enum(['connecting', 'qr_pending', 'connected', 'disconnected', 'logged_out']),
  phone: z.string().nullable(),
  connectedAt: z.number().nullable(),
  lastSeen: z.number().nullable(),
  hasSession: z.boolean(),
  qrAvailable: z.boolean(),
});

const QrSchema = z.object({
  qr: z.string().nullable(),
  updatedAt: z.number().nullable(),
});

/** Одна SSE-рамка. Вынесено для unit-тестов формата. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const HEARTBEAT_MS = 25_000;

export async function whatsappRoutes(app: FastifyInstance, ctrl: WhatsAppController): Promise<void> {
  app.get('/api/whatsapp/status', async (_req, reply) => {
    const parsed = StatusSchema.safeParse(ctrl.snapshot());
    if (!parsed.success) {
      app.log.error({ issues: parsed.error.issues }, 'status snapshot violates contract');
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });

  app.get('/api/whatsapp/qr', async (_req, reply) => {
    const parsed = QrSchema.safeParse(ctrl.qrSnapshot());
    if (!parsed.success) {
      app.log.error({ issues: parsed.error.issues }, 'qr snapshot violates contract');
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });

  // Server-Sent Events: snapshot сразу, дальше qr/status по мере событий.
  // Фронт: EventSource('/api/whatsapp/events'), рендер QR через qrcode.react.
  app.get('/api/whatsapp/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown): void => {
      try {
        reply.raw.write(formatSseEvent(event, data));
      } catch {
        // client gone — cleanup below on 'close'
      }
    };
    send('snapshot', ctrl.snapshot());
    const offQr = ctrl.on('qr', (d) => send('qr', d));
    const offStatus = ctrl.on('status', (d) => send('status', d));
    const hb = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // ignore, 'close' handler cleans up
      }
    }, HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(hb);
      offQr();
      offStatus();
    });
  });

  app.post('/api/whatsapp/disconnect', async (_req, reply) => {
    const parsed = StatusSchema.safeParse(ctrl.disconnect());
    if (!parsed.success) {
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });

  // Вне спеки API (там только disconnect), но без неё UI не сможет
  // переподключиться после ручного disconnect — маленькое расширение.
  app.post('/api/whatsapp/connect', async (_req, reply) => {
    const parsed = StatusSchema.safeParse(await ctrl.connect());
    if (!parsed.success) {
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });
}
