/**
 * QrStore — последний актуальный QR для WEB-интерфейса.
 * Baileys присылает новый QR каждые ~60 сек, пока не сканирован;
 * фронт получает обновления через SSE, снапшот — через GET /api/whatsapp/qr.
 * Здесь только сырая строка: рендерит QR сам фронт (qrcode.react),
 * бэкенд картинки не генерирует. Auth credentials тут не хранятся.
 */
export type QrSnapshot = {
  qr: string | null;
  /** ms epoch обновления; null если QR ещё не приходил */
  updatedAt: number | null;
};

export class QrStore {
  private qr: string | null = null;
  private updatedAt: number | null = null;

  set(qr: string): void {
    this.qr = qr;
    this.updatedAt = Date.now();
  }

  clear(): void {
    this.qr = null;
    this.updatedAt = null;
  }

  snapshot(): QrSnapshot {
    return { qr: this.qr, updatedAt: this.updatedAt };
  }
}
