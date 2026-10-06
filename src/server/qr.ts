import QRCode from 'qrcode';

/**
 * QR в PNG data URL для GET /api/whatsapp/qr (шаг 5):
 * фронт показывает <img>, бэкенд кэширует по строке (Baileys ротирует
 * QR ~раз в минуту — не перегенерируем один и тот же).
 */
export class QrPng {
  private lastQr: string | null = null;
  private lastUrl: string | null = null;

  async toDataUrl(qr: string | null): Promise<string | null> {
    if (!qr) return null;
    if (qr === this.lastQr && this.lastUrl) return this.lastUrl;
    const url = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
    this.lastQr = qr;
    this.lastUrl = url;
    return url;
  }
}
