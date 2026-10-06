import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'wasec';

export type AuthOptions = {
  /** пусто = авторизация выключена (только для 127.0.0.1, проверяется при старте) */
  password: string;
  loginMaxAttempts?: number;
  loginWindowMs?: number;
};

type Attempt = { count: number; windowStart: number };

/**
 * Минимальная сессионная авторизация без зависимостей (шаг 5):
 * - пароль сверяется в constant-time;
 * - сессия — случайный токен в httpOnly+sameSite cookie, токены в памяти;
 * - rate limit на /api/auth/login по IP.
 */
export class Auth {
  private readonly sessions = new Set<string>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(private readonly opts: AuthOptions) {
    this.maxAttempts = opts.loginMaxAttempts ?? 10;
    this.windowMs = opts.loginWindowMs ?? 10 * 60_000;
  }

  get enabled(): boolean {
    return this.opts.password !== '';
  }

  verifyPassword(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || candidate === '') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.opts.password);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  createSession(): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.add(token);
    return token;
  }

  checkCookie(header: string | undefined): boolean {
    if (!header) return false;
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === SESSION_COOKIE && rest.join('=')) {
        return this.sessions.has(rest.join('='));
      }
    }
    return false;
  }

  isRateLimited(ip: string, now: number = Date.now()): boolean {
    const a = this.attempts.get(ip);
    if (!a || now - a.windowStart >= this.windowMs) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return false;
    }
    a.count += 1;
    return a.count > this.maxAttempts;
  }

  sessionCookieHeader(token: string): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  }
}

const OPEN_PATHS = new Set(['/health', '/api/health', '/api/auth/login']);

/** preHandler: закрывает /api/* при включённой авторизации. */
export function authGuard(auth: Auth) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!auth.enabled) return;
    if (req.method === 'OPTIONS') return;
    if (OPEN_PATHS.has(req.url.split('?')[0] ?? '')) return;
    if (!req.url.startsWith('/api/')) return;
    if (!auth.checkCookie(req.headers.cookie)) {
      await reply.code(401).send({ error: 'требуется вход: POST /api/auth/login' });
    }
  };
}
