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
  /** Пароль веб-интерфейса. Обязателен всегда, кроме явного ALLOW_NO_AUTH. */
  WEB_PASSWORD: optString(''),
  /** явный флаг тестов/локалки; без него пустой пароль = отказ в старте */
  ALLOW_NO_AUTH: optBool(false),
  /** доверять X-Forwarded-* от proxy (иначе игнорируются) */
  TRUST_PROXY: optBool(false),
  /** дополнительные Host сверх 127.0.0.1/localhost, через запятую */
  ALLOWED_HOSTS: optString(''),

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
  /** Какие новые чаты анализировать: none — никакие, direct — только лички (по умолчанию), all — все. */
  ANALYZE_NEW_CHATS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : String(v).toLowerCase()),
    z.enum(['none', 'direct', 'all'], { error: 'ANALYZE_NEW_CHATS: none|direct|all' }).default('direct'),
  ),
  /** Fallback auto-провайдера на эвристику при ошибке primary (созданное → needs_review). */
  ALLOW_HEURISTIC_FALLBACK: optBool(false),
  /** Время дневного дайджеста HH:MM в TIMEZONE (шаг 7). */
  DIGEST_TIME: optString('18:00').superRefine((v, ctx) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'DIGEST_TIME: нужно HH:MM, например 18:00' });
    }
  }),
  /** Бэкапы sqlite: держать последние N (шаг 9). */
  BACKUP_KEEP_N: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'BACKUP_KEEP_N: нужно целое число, например 7' }).int().min(1).max(365).default(7),
  ),
  /** Папка бэкапов (внутри тома data). */
  BACKUP_DIR: optString('./data/backups'),
  /** Ретеншн текстов сообщений в днях; 0 = выключено (шаг 9). */
  RETENTION_DAYS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'RETENTION_DAYS: нужно целое число дней, 0 = выключено' }).int().min(0).max(3650).default(0),
  ),
  /** Обезличивание закрытых задач (title/description) старше N дней; 0 = выключено. */
  RETENTION_TASKS_DAYS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'RETENTION_TASKS_DAYS: нужно целое число дней, 0 = выключено' }).int().min(0).max(3650).default(0),
  ),
  /** Транскрибация голосовых (шаг 10). ВЫКЛЮЧЕНА по умолчанию: аудио уходит стороннему ASR. */
  TRANSCRIBE_VOICE: optBool(false),
  TRANSCRIBE_URL: optString('https://api.openai.com/v1'),
  TRANSCRIBE_MODEL: optString('whisper-1'),
  TRANSCRIBE_API_KEY: optString(''),
  /** минут ожидания транскрипта перед анализом голосового (по умолчанию 5) */
  VOICE_GRACE_MIN: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: 'VOICE_GRACE_MIN: нужно целое число минут, например 5' }).int().min(0).max(1440).default(5),
  ),
  /** язык транскрибации; auto = параметр не передаётся */
  TRANSCRIBE_LANGUAGE: optString('auto'),
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
  allowNoAuth: raw.ALLOW_NO_AUTH,
  trustProxy: raw.TRUST_PROXY,
  allowedHosts: raw.ALLOWED_HOSTS === '' ? [] : raw.ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean),
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
  analyzeNewChats: raw.ANALYZE_NEW_CHATS,
  allowHeuristicFallback: raw.ALLOW_HEURISTIC_FALLBACK,
  digestTime: raw.DIGEST_TIME,
  backupKeepN: raw.BACKUP_KEEP_N,
  backupDir: raw.BACKUP_DIR,
  retentionDays: raw.RETENTION_DAYS,
  retentionTasksDays: raw.RETENTION_TASKS_DAYS,
  transcribeVoice: raw.TRANSCRIBE_VOICE,
  transcribeUrl: raw.TRANSCRIBE_URL,
  transcribeModel: raw.TRANSCRIBE_MODEL,
  transcribeApiKey: raw.TRANSCRIBE_API_KEY,
  voiceGraceMin: raw.VOICE_GRACE_MIN,
  transcribeLanguage: raw.TRANSCRIBE_LANGUAGE,
  aiTemperature: raw.AI_TEMPERATURE,
  openrouterApiKey: raw.OPENROUTER_API_KEY,
  openrouterModel: raw.OPENROUTER_MODEL,
  openrouterUrl: raw.OPENROUTER_URL,
  openrouterAppTitle: raw.OPENROUTER_APP_TITLE,
  openrouterSiteUrl: raw.OPENROUTER_SITE_URL,
} as const;
