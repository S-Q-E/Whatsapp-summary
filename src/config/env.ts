import 'dotenv/config';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v !== undefined && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  logLevel: str('LOG_LEVEL', 'info'),
  logPretty: bool('LOG_PRETTY', true),
  /** When true, debug logs may include a truncated preview of message text. */
  logMessageContent: bool('LOG_MESSAGE_CONTENT', false),
  authDir: str('AUTH_DIR', './data/auth'),
  browserName: str('BROWSER_NAME', 'WhatsApp AI Secretary'),
  markOnlineOnConnect: bool('MARK_ONLINE_ON_CONNECT', false),
  syncFullHistory: bool('SYNC_FULL_HISTORY', false),
  sqlitePath: str('SQLITE_PATH', './data/whatsapp.db'),
  // --- AI analysis ---
  /** auto = cloud (OpenRouter, если задан ключ) или Ollama, иначе эвристика. Также: openrouter | ollama | heuristic | mock */
  aiProvider: str('AI_PROVIDER', 'auto'),
  ollamaUrl: str('OLLAMA_URL', 'http://localhost:11434'),
  aiModel: str('AI_MODEL', 'qwen2.5:7b'),
  aiTimeoutMs: num('AI_TIMEOUT_MS', 120_000),
  aiTemperature: num('AI_TEMPERATURE', 0),
  // --- OpenRouter (облако, для слабого ноутбука) ---
  openrouterApiKey: str('OPENROUTER_API_KEY', ''),
  openrouterModel: str('OPENROUTER_MODEL', 'openai/gpt-4o-mini'),
  openrouterUrl: str('OPENROUTER_URL', 'https://openrouter.ai/api/v1'),
  openrouterAppTitle: str('OPENROUTER_APP_TITLE', 'WhatsApp AI Secretary'),
  openrouterSiteUrl: str('OPENROUTER_SITE_URL', ''),
} as const;
