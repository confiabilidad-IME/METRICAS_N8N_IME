// Función de Vercel (api/index.js, generada con `npm run build:api`). Misma API y mismo login que el servidor Node, pero sin
// proceso permanente: no hay temporizador ni SSE. n8n se consulta BAJO DEMANDA (si el dato tiene más de FRESH_MS) y la
// página consulta /api/snapshot cada ~30 s (AccessInfo.polling).
//
// Cosas que cambian respecto al servidor Node, y por qué:
// - El secreto de sesión es OBLIGATORIO (AUDIT_SESSION_SECRET): cada petición puede caer en otra instancia, y con un
//   secreto aleatorio por instancia las sesiones se romperían al azar.
// - El límite de intentos de login vive en memoria de cada instancia: frena la fuerza bruta, pero es más laxo que en un
//   servidor único. Usa contraseñas largas (las de `npm run user:init` lo son).
// - Vercel decide qué dominios llegan aquí, así que la lista de hosts permitidos se rellena con el host de la petición.
import type { IncomingMessage, ServerResponse } from 'node:http';
import pkg from '../../package.json';
import { createAuth, type Auth } from '../auth';
import { sessionSecret, Sessions } from '../auth/session';
import { loadUsers } from '../auth/users';
import { loadEnv, readAuditConfig } from '../audit/config';
import { AuditPoller } from '../audit/poller';
import { createApi, sendJson, type SnapshotSource } from '../http/app';
import { createRequestGuard, hostnameOf, parseAllowedHosts } from '../http/guard';
import { N8nOffice } from '../model/n8n-office';

/** Un dato de n8n más viejo que esto se vuelve a pedir antes de responder. */
export const FRESH_MS = 20_000;

export interface HandlerDeps {
  /** Variables de entorno (por defecto, process.env más un .env local si existe). */
  env?: Record<string, string | undefined>;
  rootDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Equivale a estar en Vercel: confía en el proxy y acepta el host de la petición. */
  platform?: boolean;
}

interface State {
  auth: Auth;
  api: ReturnType<typeof createApi>;
  poller: AuditPoller;
  extraHosts: Set<string>;
  platform: boolean;
}

/** Error de configuración (no del usuario): se informa con el motivo para poder corregirlo en Vercel. */
class ConfigError extends Error {}

export function createHandler(deps: HandlerDeps = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const rootDir = deps.rootDir ?? process.cwd();
  const now = deps.now ?? Date.now;
  let state: State | ConfigError | undefined;

  function build(): State {
    const env = deps.env ?? loadEnv(process.env, rootDir);
    const platform = deps.platform ?? env.VERCEL === '1';
    let users: ReturnType<typeof loadUsers>;
    try {
      users = loadUsers(env, rootDir);
    } catch (e) {
      throw new ConfigError(`usuarios: ${(e as Error).message}`);
    }
    if (users.length === 0) throw new ConfigError('no hay usuarios activos: incluye users.default.json en el despliegue o define AUDIT_USERS.');
    const { secret, persistent } = sessionSecret(env.AUDIT_SESSION_SECRET);
    if (!persistent) throw new ConfigError('falta AUDIT_SESSION_SECRET (mínimo 32 caracteres) en las variables de entorno.');
    const cfg = readAuditConfig(env);
    const poller = new AuditPoller(cfg, { fetchImpl: deps.fetchImpl, now });
    const office = new N8nOffice(poller, { version: pkg.version, baseUrl: cfg?.baseUrl ?? '', demo: cfg?.demo ?? false, now });
    const hub: SnapshotSource = { current: () => ({ ...office.commit().snapshot, serverTime: now() }) };
    const hours = Math.min(Math.max(Number(env.AUDIT_SESSION_HOURS) || 12, 1), 24 * 30);
    const auth = createAuth({ users, sessions: new Sessions(secret, hours * 3600_000, now), trustProxy: platform || env.AUDIT_TRUST_PROXY === '1', secureCookie: env.AUDIT_COOKIE_SECURE === '1' });
    return { auth, api: createApi({ office, hub, poller, version: pkg.version, demo: cfg?.demo ?? false }), poller, extraHosts: parseAllowedHosts(env.AUDIT_ALLOWED_HOSTS), platform };
  }

  function get(): State {
    if (!state) {
      try {
        state = build();
      } catch (e) {
        // Se recuerda el error: no se reintenta en cada petición, pero un redeploy con la variable corregida lo limpia.
        state = e instanceof ConfigError ? e : new ConfigError(`configuración inválida (${(e as Error).message})`);
      }
    }
    if (state instanceof ConfigError) throw state;
    return state;
  }

  /** Datos que dependen del sondeo a n8n: se refrescan si están viejos (varias peticiones comparten una sola consulta). */
  async function ensureFresh(poller: AuditPoller): Promise<void> {
    const s = poller.snapshot();
    if (s.status === 'disabled') return;
    const age = s.fetchedAt ? now() - s.fetchedAt : Infinity;
    if (age > FRESH_MS || s.status === 'pending' || s.status === 'error') await poller.refresh();
  }

  return async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      url = new URL('/', 'http://localhost');
    }
    try {
      const s = get();
      const host = hostnameOf(req.headers.host);
      const guard = createRequestGuard({ allowedHosts: new Set([...s.extraHosts, ...(s.platform && host ? [host] : [])]) });
      if (guard(req, res)) return;
      if (s.auth.handle(req, res, url) || !s.auth.allowed(req, res, url)) return;
      if (url.pathname === '/api/snapshot' || (url.pathname === '/api/audit' && !url.searchParams.has('desde') && !url.searchParams.has('hasta'))) await ensureFresh(s.poller);
      if (!s.api(req, res, url)) sendJson(res, 404, { error: 'no existe' });
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      if (err instanceof ConfigError) {
        // El motivo ayuda a quien despliega; no incluye valores secretos (solo nombres de variables).
        if (url.pathname.startsWith('/api/')) sendJson(res, 500, { error: `Configuración incompleta: ${err.message}` });
        else {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(`Configuración incompleta: ${err.message}`);
        }
        return;
      }
      sendJson(res, 500, { error: 'error interno' });
    }
  };
}

/** Punto de entrada de Vercel: el estado (sondeo, caché) vive mientras la instancia siga caliente. */
export default createHandler();
