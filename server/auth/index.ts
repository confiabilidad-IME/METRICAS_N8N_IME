// Autenticación del tablero: sin sesión válida no se sirve nada (ni la página ni la API), salvo /login y /api/health.
//
//   GET  /login          -> página de inicio de sesión (si ya hay sesión, redirige a /)
//   POST /api/login      {usuario, password} -> 200 + cookie HttpOnly; 401 mensaje genérico; 429 si hay demasiados intentos
//   POST /api/logout     -> borra la cookie
//   GET  /api/session    -> {usuario} (401 sin sesión)
//
// Los mensajes de error no distinguen "usuario inexistente" de "contraseña errónea", y ambos casos tardan lo mismo.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditRole } from '../../shared/audit';
import { sendJson } from '../http/app';
import { AttemptLimiter } from './limiter';
import { LOGIN_CSP, LOGIN_HTML } from './login-page';
import { dummyHash, verifyPassword } from './passwords';
import { clearCookie, parseCookies, sessionCookie, Sessions } from './session';
import { normalizeUsername, type AuthUser } from './users';

const COOKIE = 'audit_session';
const BODY_MAX = 2048;
const GENERIC_FAIL = 'Usuario o contraseña incorrectos.';

export interface AuthOptions {
  users: readonly AuthUser[];
  sessions: Sessions;
  /** Confiar en X-Forwarded-For / X-Forwarded-Proto (solo detrás de un proxy propio: Render, Railway, nginx…). */
  trustProxy?: boolean;
  /** Forzar la marca Secure de la cookie (HTTPS). Con trustProxy se deduce de X-Forwarded-Proto. */
  secureCookie?: boolean;
  maxAttempts?: number;
  windowMs?: number;
}

export interface Auth {
  /** Atiende /login y /api/{login,logout,session}. Devuelve true si respondió. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  /** ¿Puede continuar la petición? Si no, ya respondió (401 en la API, redirección a /login en páginas). */
  allowed(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  user(req: IncomingMessage): string | null;
  /** Rol del usuario con sesión; null sin sesión válida. */
  role(req: IncomingMessage): AuditRole | null;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function createAuth(opts: AuthOptions): Auth {
  const byName = new Map(opts.users.map((u) => [u.name, u]));
  const perUser = new AttemptLimiter(opts.maxAttempts ?? 5, opts.windowMs ?? 15 * 60_000);
  const perIp = new AttemptLimiter((opts.maxAttempts ?? 5) * 4, opts.windowMs ?? 15 * 60_000);

  const ip = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'desconocida';
  };
  const secure = (req: IncomingMessage): boolean => {
    if (opts.secureCookie) return true;
    if (opts.trustProxy) return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
    return false;
  };
  const user = (req: IncomingMessage): string | null => {
    const name = opts.sessions.verify(parseCookies(req.headers.cookie)[COOKIE]);
    // Si el usuario se desactivó o se quitó, su cookie vigente deja de valer.
    return name && byName.has(name) ? name : null;
  };

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = ip(req);
    const wait = Math.max(perIp.retryAfter(key), 0);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      return sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    }
    const raw = await readBody(req);
    let body: { usuario?: unknown; password?: unknown } = {};
    try {
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      return sendJson(res, 400, { error: 'Solicitud inválida.' });
    }
    if (typeof body.usuario !== 'string' || typeof body.password !== 'string' || body.usuario.length > 64 || body.password.length > 200 || !body.password) {
      return sendJson(res, 400, { error: 'Escribe tu usuario y contraseña.' });
    }
    const name = normalizeUsername(body.usuario);
    const userKey = `${key}|${name}`;
    const userWait = perUser.retryAfter(userKey);
    if (userWait > 0) {
      res.setHeader('Retry-After', String(userWait));
      return sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    }
    const found = byName.get(name);
    // Siempre se calcula un hash (el real o uno de relleno): el tiempo no delata si el usuario existe.
    const ok = await verifyPassword(body.password, found ? found.hash : await dummyHash());
    if (!found || !ok) {
      perUser.fail(userKey);
      perIp.fail(key);
      return sendJson(res, 401, { error: GENERIC_FAIL });
    }
    perUser.reset(userKey);
    res.setHeader('Set-Cookie', sessionCookie(COOKIE, opts.sessions.issue(found.name), opts.sessions.ttlSeconds, secure(req)));
    sendJson(res, 200, { ok: true, usuario: found.name });
  }

  const role = (req: IncomingMessage): AuditRole | null => {
    const name = user(req);
    return name ? (byName.get(name)?.role ?? 'admin') : null;
  };

  return {
    user,
    role,
    handle(req, res, url) {
      const path = url.pathname;
      if (path === '/login') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD');
          sendJson(res, 405, { error: 'método no permitido' });
          return true;
        }
        if (user(req)) {
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
          res.end();
          return true;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': LOGIN_CSP,
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(req.method === 'HEAD' ? undefined : LOGIN_HTML);
        return true;
      }
      if (path === '/api/login') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          sendJson(res, 405, { error: 'método no permitido' });
        } else void login(req, res).catch(() => !res.headersSent && sendJson(res, 500, { error: 'error interno' }));
        return true;
      }
      if (path === '/api/logout') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          sendJson(res, 405, { error: 'método no permitido' });
        } else {
          res.setHeader('Set-Cookie', clearCookie(COOKIE, secure(req)));
          sendJson(res, 200, { ok: true });
        }
        return true;
      }
      if (path === '/api/session') {
        const name = user(req);
        if (name) sendJson(res, 200, { usuario: name, rol: role(req) });
        else sendJson(res, 401, { error: 'no autenticado' });
        return true;
      }
      return false;
    },
    allowed(req, res, url) {
      if (url.pathname === '/api/health' || user(req)) return true;
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 401, { error: 'no autenticado' });
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        res.end();
      } else {
        sendJson(res, 401, { error: 'no autenticado' });
      }
      return false;
    },
  };
}
