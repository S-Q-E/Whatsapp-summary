import 'dotenv/config';
import { z } from 'zod';
import { ru } from 'zod/locales';
import { assertTimeZone } from '../utils/time.js';

// Все тексты ошибок конфига — на русском (AGENTS.md).
z.config({ localeError: ru().localeError });

/** Пустая строка считается неустановленным значением (как раньше). */
const optString = (fallback: string) =>
  z.preprocess((v) => (v === '' || v === undefined ? undefined : v), z.string().default(fallback));

const optBool = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v === true || v === 'true' || v === '1'),
    z.boolean().default(fallback),
  );

const envSchema = z.object({
  LOG_LEVEL: optString('info'),
  LOG_PRETTY: optBool(true),
  /** Когда true, debug-логи могут содержать обрезанный превью-текст сообщений. */
  LOG_MESSAGE_CONTENT: optBool(false),

  AUTH_DIR: optString('./data/auth'),
  BROWSER_NAME: optString('WhatsApp AI Secretary'),
  MARK_ONLINE_ON_CONNECT: optBool(false),
  SYNC_FULL_HISTORY: optBool(false),
  SQLITE_PATH: optString('./data/whatsapp.db'),

  // --- Веб-сервер (слушает только локально, авторизация — следующим шагом) ---
  WEB_HOST: optString('127.0.0.1'),
  WEB_PORT: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'WEB_PORT: нужен номер порта, например 3000' }).int().min(1).max(65_535).default(3000),
  ),
  /** Пароль веб-интерфейса (пусто = пока без авторизации, закроем следующим шагом). */
  WEB_PASSWORD: optString(''),

  // --- Время: единая зона для границ дня, промпта и UI ---
  TIMEZONE: optString('Asia/Almaty').superRefine((tz, ctx) => {
    try {
      assertTimeZone(tz);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `TIMEZONE: неизвестная временная зона "${tz}", пример: Asia/Almaty`,
      });
    }
  }),
  /** JID владельца (куда слать дайджест). Пусто = ещё не задан. */
  OWNER_JID: optString(''),

  // --- AI ---
  AI_PROVIDER: optString('auto'),
  OLLAMA_URL: optString('http://localhost:11434'),
  AI_MODEL: optString('qwen2.5:7b'),
  AI_TIMEOUT_MS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'AI_TIMEOUT_MS: нужны миллисекунды числом, например 120000' }).int().positive().default(120_000),
  ),
  /** Планировщик анализа: период прохода в минутах (шаг 5). */
  ANALYZE_INTERVAL_MIN: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'ANALYZE_INTERVAL_MIN: нужно целое число минут, например 2' }).int().min(1).max(1440).default(2),
  ),
  /** Максимум чатов за один проход планировщика. */
  ANALYZE_MAX_CHATS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'ANALYZE_MAX_CHATS: нужно целое число, например 10' }).int().min(1).max(1000).default(10),
  ),
  /** Печатать QR в терминал (standalone ingestion); в серверном режиме QR только в WEB. */
  QR_TERMINAL: optBool(false),
  /** Контекст чата: последние N сообщений за окно (шаг 3). */
  AI_CONTEXT_LIMIT: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'AI_CONTEXT_LIMIT: нужно целое число, например 40' }).int().min(1).max(500).default(40),
  ),
  AI_CONTEXT_DAYS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'AI_CONTEXT_DAYS: нужно целое число дней, например 14' }).int().min(1).max(90).default(14),
  ),
  /** Fallback auto-провайдера на эвристику при ошибке primary (созданное → needs_review). */
  ALLOW_HEURISTIC_FALLBACK: optBool(false),
  AI_TEMPERATURE: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'AI_TEMPERATURE: нужно число 0..2' }).min(0).max(2).default(0),
  ),
  OPENROUTER_API_KEY: optString(''),
  OPENROUTER_MODEL: optString('openai/gpt-4o-mini'),
  OPENROUTER_URL: optString('https://openrouter.ai/api/v1'),
  OPENROUTER_APP_TITLE: optString('WhatsApp AI Secretary'),
  OPENROUTER_SITE_URL: optString(''),
});

function loadEnv(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${String(i.path[0] ?? 'env')}: ${i.message}`);
    throw new Error(`Ошибка конфигурации (.env):\n${lines.join('\n')}`);
  }
  return parsed.data;
}

const raw = loadEnv();

export const env = {
  logLevel: raw.LOG_LEVEL,
  logPretty: raw.LOG_PRETTY,
  logMessageContent: raw.LOG_MESSAGE_CONTENT,
  authDir: raw.AUTH_DIR,
  browserName: raw.BROWSER_NAME,
  markOnlineOnConnect: raw.MARK_ONLINE_ON_CONNECT,
  syncFullHistory: raw.SYNC_FULL_HISTORY,
  sqlitePath: raw.SQLITE_PATH,
  webHost: raw.WEB_HOST,
  webPort: raw.WEB_PORT,
  webPassword: raw.WEB_PASSWORD,
  timezone: raw.TIMEZONE,
  ownerJid: raw.OWNER_JID,
  aiProvider: raw.AI_PROVIDER,
  ollamaUrl: raw.OLLAMA_URL,
  aiModel: raw.AI_MODEL,
  aiTimeoutMs: raw.AI_TIMEOUT_MS,
  analyzeIntervalMin: raw.ANALYZE_INTERVAL_MIN,
  analyzeMaxChats: raw.ANALYZE_MAX_CHATS,
  qrTerminal: raw.QR_TERMINAL,
  aiContextLimit: raw.AI_CONTEXT_LIMIT,
  aiContextDays: raw.AI_CONTEXT_DAYS,
  allowHeuristicFallback: raw.ALLOW_HEURISTIC_FALLBACK,
  aiTemperature: raw.AI_TEMPERATURE,
  openrouterApiKey: raw.OPENROUTER_API_KEY,
  openrouterModel: raw.OPENROUTER_MODEL,
  openrouterUrl: raw.OPENROUTER_URL,
  openrouterAppTitle: raw.OPENROUTER_APP_TITLE,
  openrouterSiteUrl: raw.OPENROUTER_SITE_URL,
} as const;
