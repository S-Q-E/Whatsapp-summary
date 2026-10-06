import type { ServerResponse } from 'node:http';

type WritableEnd = {
  write: (chunk: string) => boolean;
  end: () => void;
};

/**
 * Реестр открытых SSE-ответов (шаг 6, п.3). Hijacked-соединения держат
 * открытыми сокеты сервера, поэтому app.close() без их завершения висит.
 * Порядок shutdown: hub.closeAll() → app.close() → closeDatabase().
 */
export class SseHub {
  private readonly active = new Set<WritableEnd>();

  /** Регистрирует ответ; возвращает unsubscribe. */
  add(res: WritableEnd): () => void {
    this.active.add(res);
    return () => {
      this.active.delete(res);
    };
  }

  get size(): number {
    return this.active.size;
  }

  /** Завершить все висящие ответы (идемпотентно). */
  closeAll(): void {
    for (const res of [...this.active]) {
      this.active.delete(res);
      try {
        res.end();
      } catch {
        // клиент уже ушёл — нечего завершать
      }
    }
  }
}

export type SseResponse = Pick<ServerResponse, 'writeHead' | 'write' | 'end'>;
