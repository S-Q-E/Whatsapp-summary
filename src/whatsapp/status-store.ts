export type WaStatus =
  | 'connecting'
  | 'qr_pending'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export type StatusSnapshot = {
  status: WaStatus;
  /** JID подключённого аккаунта (user.id из Baileys), null пока не подключён */
  phone: string | null;
  /** ms epoch установки соединения */
  connectedAt: number | null;
  /** ms epoch последней активности соединения */
  lastSeen: number | null;
  /** есть ли сохранённая auth-сессия на диске (т.е. рестарт пройдёт без QR) */
  hasSession: boolean;
  /** есть ли свежий QR для сканирования прямо сейчас */
  qrAvailable: boolean;
};

/**
 * Чистая логика статуса соединения (без Baileys и fs — всё через инъекции,
 * поэтому покрывается unit-тестами). События наружу отдаёт WhatsAppManager.
 */
export class StatusStore {
  private status: WaStatus = 'disconnected';
  private phone: string | null = null;
  private connectedAt: number | null = null;
  private lastSeen: number | null = null;

  constructor(private readonly hasSessionCheck: () => boolean) {}

  onQr(): void {
    this.status = 'qr_pending';
    this.touch();
  }

  onConnected(phone: string | null): void {
    this.status = 'connected';
    this.phone = phone;
    const now = Date.now();
    this.connectedAt = now;
    this.lastSeen = now;
  }

  onConnecting(): void {
    if (this.status !== 'connected') {
      this.status = 'connecting';
      this.touch();
    }
  }

  onManualDisconnect(): void {
    this.status = 'disconnected';
    this.phone = null;
    this.touch();
  }

  onLoggedOut(): void {
    this.status = 'logged_out';
    this.phone = null;
    this.connectedAt = null;
    this.touch();
  }

  private touch(): void {
    this.lastSeen = Date.now();
  }

  snapshot(qrAvailable: boolean): StatusSnapshot {
    return {
      status: this.status,
      phone: this.phone,
      connectedAt: this.connectedAt,
      lastSeen: this.lastSeen,
      hasSession: this.hasSessionCheck(),
      qrAvailable,
    };
  }
}
