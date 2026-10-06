import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QrEvent } from '../../whatsapp/manager.js';
import type { StatusSnapshot, WaStatus } from '../../whatsapp/status-store.js';

/**
 * Минимальный интерфейс, нужный routes. WhatsAppManager его реализует;
 * в тестах подставляется stub — HTTP-слой проверяется через app.inject
 * без живого сокета.
 */
export type WhatsAppController = {
  snapshot(): StatusSnapshot;
  qrString(): string | null;
  on(event: 'qr' | 'status', cb: (data: QrEvent | StatusSnapshot) => void): () => void;
  disconnect(): StatusSnapshot;
  connect(): Promise<StatusSnapshot>;
  logout(): Promise<StatusSnapshot>;
};

/** Состояния наружу (шаг 5): qr_pending→qr, connected→open, disconnected→closed. */
export type PublicWaState = 'connecting' | 'qr' | 'open' | 'closed' | 'logged_out';

export function mapState(s: WaStatus): PublicWaState {
  switch (s) {
    case 'qr_pending':
      return 'qr';
    case 'connected':
      return 'open';
    case 'disconnected':
      return 'closed';
    default:
      return s;
  }
}

const StatusSchema = z.object({
  state: z.enum(['connecting', 'qr', 'open', 'closed', 'logged_out']),
  phone: z.string().nullable(),
  connectedAt: z.number().nullable(),
  lastSeen: z.number().nullable(),
  hasSession: z.boolean(),
  qrAvailable: z.boolean(),
});

const QrSchema = z.object({
  dataUrl: z.string().nullable(),
  updatedAt: z.number().nullable(),
});

const LogoutSchema = z.object({
  confirm: z.literal(true, { error: 'нужно тело {"confirm": true}' }),
});

/** Одна SSE-рамка. Вынесено для unit-тестов формата. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const HEARTBEAT_MS = 25_000;

function publicStatus(s: StatusSnapshot): z.infer<typeof StatusSchema> {
  return {
    state: mapState(s.status),
    phone: s.phone,
    connectedAt: s.connectedAt,
    lastSeen: s.lastSeen,
    hasSession: s.hasSession,
    qrAvailable: s.qrAvailable,
  };
}

export type QrRenderer = (qr: string | null) => Promise<string | null>;

export async function whatsappRoutes(
  app: FastifyInstance,
  ctrl: WhatsAppController,
  qrPng: QrRenderer,
): Promise<void> {
  const sendStatus = (s: StatusSnapshot) => StatusSchema.safeParse(publicStatus(s));

  app.get('/api/whatsapp/status', async (_req, reply) => {
    const parsed = sendStatus(ctrl.snapshot());
    if (!parsed.success) {
      app.log.error({ issues: parsed.error.issues }, 'status snapshot violates contract');
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });

  // QR как PNG data URL: фронт показывает <img src=dataUrl>.
  app.get('/api/whatsapp/qr', async (_req, reply) => {
    const qr = ctrl.qrString();
    const parsed = QrSchema.safeParse({ dataUrl: qr ? await qrPng(qr) : null, updatedAt: Date.now() });
    if (!parsed.success) {
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });

  // Server-Sent Events: snapshot сразу, дальше qr/status по мере событий.
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
    send('snapshot', publicStatus(ctrl.snapshot()));
    const offQr = ctrl.on('qr', (d) => send('qr', d));
    const offStatus = ctrl.on('status', (d) => send('status', publicStatus(d as StatusSnapshot)));
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
    const parsed = sendStatus(ctrl.disconnect());
    if (!parsed.success) {
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });

  app.post('/api/whatsapp/connect', async (_req, reply) => {
    const parsed = sendStatus(await ctrl.connect());
    if (!parsed.success) {
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });

  // Полный выход: закрыть соединение + стереть auth-сессию. Требует confirm.
  app.post('/api/whatsapp/logout', async (req, reply) => {
    const body = LogoutSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'нужно тело {"confirm": true}' });
    }
    const parsed = sendStatus(await ctrl.logout());
    if (!parsed.success) {
      return reply.code(500).send({ error: 'internal contract violation' });
    }
    return reply.send(parsed.data);
  });
}
