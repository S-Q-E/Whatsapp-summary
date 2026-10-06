import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'wasec';
/** 7 дней — и в cookie Max-Age, и в TTL сессий. */
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;

export type AuthOptions = {
  password: string;
  /** явный флаг тестов/локалки; без него пустой пароль = всё закрыто */
  allowNoAuth?: boolean;
  loginMaxAttempts?: number;
  loginWindowMs?: number;
  sessionTtlMs?: number;
  /** дополнительные Host сверх 127.0.0.1/localhost/::1 */
  allowedHosts?: string[];
};

type Attempt = { count: number; windowStart: number };

/**
 * Сессионная авторизация без зависимостей:
 * - пароль сверяется в constant-time;
 * - сессия — случайный токен в httpOnly+sameSite cookie (+Secure под https),
 *   токены в памяти с TTL 7 дней и чисткой просроченных;
 * - rate limit на /api/auth/login по IP.
 */
export class Auth {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly ttlMs: number;
  private readonly allowedHosts: Set<string>;

  constructor(private readonly opts: AuthOptions) {
    this.maxAttempts = opts.loginMaxAttempts ?? 10;
    this.windowMs = opts.loginWindowMs ?? 10 * 60_000;
    this.ttlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
    this.allowedHosts = new Set(
      ['127.0.0.1', 'localhost', '::1', ...(opts.allowedHosts ?? [])].map((h) => h.toLowerCase()),
    );
  }

  /** Открытый режим — только явный ALLOW_NO_AUTH (тесты, локалка). */
  get openMode(): boolean {
    return this.opts.password === '' && this.opts.allowNoAuth === true;
  }

  verifyPassword(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || candidate === '') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.opts.password);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  createSession(now: number = Date.now()): string {
    this.sweep(now);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, now + this.ttlMs);
    return token;
  }

  checkCookie(header: string | undefined, now: number = Date.now()): boolean {
    if (!header) return false;
    this.sweep(now);
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      const value = rest.join('=');
      if (k === SESSION_COOKIE && value) {
        const exp = this.sessions.get(value);
        if (exp !== undefined && exp > now) return true;
        return false;
      }
    }
    return false;
  }

  private sweep(now: number): void {
    for (const [token, exp] of this.sessions) {
      if (exp <= now) this.sessions.delete(token);
    }
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

  sessionCookieHeader(token: string, opts: { secure: boolean }): string {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_TTL_MS / 1000}`,
    ];
    if (opts.secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** Защита от DNS rebinding: только loopback и ALLOWED_HOSTS. */
  hostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    let host = hostHeader.toLowerCase().trim();
    if (host.startsWith('[')) {
      const end = host.indexOf(']');
      if (end === -1) return false;
      host = host.slice(1, end);
    } else {
      host = host.split(':')[0] ?? '';
    }
    return this.allowedHosts.has(host);
  }
}

type AllowRule = { method: string; pattern: string };

const ALLOWLIST: AllowRule[] = [
  { method: 'GET', pattern: '/health' },
  { method: 'GET', pattern: '/api/health' },
  { method: 'POST', pattern: '/api/auth/login' },
];

/** Мутирующие методы требуют явного AJAX-маркера (защита от drive-by). */
function hasAjaxMarker(req: FastifyRequest): boolean {
  const ct = req.headers['content-type'];
  if (typeof ct === 'string' && ct.split(';')[0]!.trim().toLowerCase() === 'application/json') {
    return true;
  }
  return req.headers['x-requested-with'] !== undefined;
}

function rawPath(req: FastifyRequest): string {
  const url = req.raw.url ?? '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Default-deny guard (решение — по сматченному маршруту, а не по строке URL):
 * - Host не из allowlist → 403;
 * - allowlist (метод + точный паттерн маршрута) → пропуск;
 * - сматченный /api/* → cookie, иначе 401;
 * - сматченная статика (не /api) → пропуск (публичный фронт);
 * - несматченное: /api/* → 404 без утечек, остальное → пропуск к SPA/static.
 * POST/PATCH/DELETE под /api/* требуют JSON Content-Type или X-Requested-With.
 */
export function authGuard(auth: Auth) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!auth.hostAllowed(req.headers.host)) {
      await reply.code(403).send({ error: 'host не разрешён' });
      return;
    }
    if (auth.openMode) return;

    const pattern = req.routeOptions?.url;
    if (typeof pattern === 'string') {
      if (ALLOWLIST.some((r) => r.method === req.method && r.pattern === pattern)) return;
      if (!pattern.startsWith('/api/')) return; // статика фронта — публична
      if (req.method === 'OPTIONS') return;
      if (!auth.checkCookie(req.headers.cookie)) {
        await reply.code(401).send({ error: 'требуется вход: POST /api/auth/login' });
        return;
      }
      if ((req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') && !hasAjaxMarker(req)) {
        await reply.code(400).send({ error: 'нужен Content-Type: application/json или заголовок X-Requested-With' });
      }
      return;
    }
    // Маршрут не сматчился: /api/* → 404 без утечек, остальное — static/SPA.
    if (rawPath(req).startsWith('/api/')) {
      await reply.code(404).send({ error: 'нет такого API' });
    }
  };
}
