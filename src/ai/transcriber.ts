import { env } from '../config/env.js';

/**
 * Абстракция распознавания речи (шаг 10). Бизнес-логика зависит только
 * от интерфейса — конкретный ASR меняется через .env.
 */
export interface Transcriber {
  readonly name: string;
  readonly model: string;
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

export type TranscriberOptions = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  language?: string;
};

type TranscribeResponse = {
  text?: string;
  error?: { message?: string };
};

/**
 * OpenAI-совместимый /audio/transcriptions (OpenAI, Groq, любой
 * совместимый endpoint). ВНИМАНИЕ: аудиофайл уходит стороннему сервису —
 * включается только флагом TRANSCRIBE_VOICE=true (см. README).
 */
export class OpenAICompatibleTranscriber implements Transcriber {
  readonly name = 'openai-compatible';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly language: string;

  constructor(opts: TranscriberOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? env.transcribeUrl).replace(/\/$/, '');
    this.model = opts.model ?? env.transcribeModel;
    this.apiKey = opts.apiKey ?? env.transcribeApiKey;
    this.timeoutMs = opts.timeoutMs ?? env.aiTimeoutMs;
    this.language = opts.language ?? 'ru';
  }

  async transcribe(audio: Buffer, mime: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('TRANSCRIBE_API_KEY is not set — voice transcription disabled');
    }
    if (audio.length === 0) throw new Error('empty audio buffer');
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), 'voice.ogg');
    form.append('model', this.model);
    form.append('language', this.language);
    form.append('response_format', 'json');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: form,
      });
    } catch (err) {
      throw new Error(`transcription service unreachable (${this.baseUrl}). Cause: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`transcription HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as TranscribeResponse;
    if (data.error) throw new Error(`transcription error: ${data.error.message ?? 'unknown'}`);
    const text = (data.text ?? '').trim();
    if (!text) throw new Error('transcription returned empty text');
    return text;
  }
}

export function createTranscriber(): Transcriber {
  return new OpenAICompatibleTranscriber();
}
