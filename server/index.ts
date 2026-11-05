// Punto de entrada: sondeo de n8n (AUD04) -> modelo -> HTTP/SSE + cliente.
//   npm run dev    -> tsx server/index.ts --dev (Vite en middleware mode, HMR en el mismo servidor)
//   npm start      -> node dist/server/index.js (sirve dist/client)
//   AUDIT_DEMO=1   -> datos ficticios, sin n8n
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { readAuditConfig, loadEnv } from './audit/config';
import { AuditPoller } from './audit/poller';
import { createApi, sendJson } from './http/app';
import { createAuth, type Auth } from './auth';
import { sessionSecret, Sessions } from './auth/session';
import { loadUsers } from './auth/users';
import { createRequestGuard, parseAllowedHosts } from './http/guard';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { errMsg, log } from './log';
import { N8nOffice } from './model/n8n-office';

/** Raíz del proyecto: primera carpeta hacia arriba con package.json (sirve igual en server/ y en dist/server/). */
function findRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

const rootDir = findRoot(import.meta.dirname);
const dev = process.argv.includes('--dev');
const env = loadEnv(process.env, rootDir);
const version = (JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';

const cfg = readAuditConfig(env);
if (!cfg) log.warn('auditoría desactivada: faltan N8N_BASE_URL y/o N8N_AUDIT_TOKEN (ver env.example). El tablero abre sin datos.');
const port = cfg?.port ?? Number(env.PORT ?? 3000);
// Solo loopback por defecto. Para publicarlo (hosting) se define AUDIT_HOST=0.0.0.0 y queda detrás del login.
const host = env.AUDIT_HOST || '127.0.0.1';

// Login: siempre activo, salvo AUDIT_AUTH=off y solo escuchando en loopback (desarrollo local sin molestias).
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
let auth: Auth | null = null;
if (env.AUDIT_AUTH === 'off') {
  if (!LOOPBACK.has(host)) {
    log.error('AUDIT_AUTH=off solo se permite con AUDIT_HOST en loopback (127.0.0.1). Quita AUDIT_AUTH=off o AUDIT_HOST.');
    process.exit(1);
  }
  log.warn('AUDIT_AUTH=off: sin inicio de sesión (solo accesible desde este equipo).');
} else {
  let users: ReturnType<typeof loadUsers> = [];
  try {
    users = loadUsers(env, rootDir);
  } catch (e) {
    log.error(`usuarios: ${(e as Error).message}`);
    process.exit(1);
  }
  if (users.length === 0) {
    log.error('no hay usuarios activos: añade users.default.json / users.json o AUDIT_USERS (ver README, npm run user:add).');
    process.exit(1);
  }
  const { secret, persistent } = sessionSecret(env.AUDIT_SESSION_SECRET);
  if (!persistent) log.warn('AUDIT_SESSION_SECRET no definido (mínimo 32 caracteres): las sesiones se cierran al reiniciar el servidor.');
  const hours = Math.min(Math.max(Number(env.AUDIT_SESSION_HOURS) || 12, 1), 24 * 30);
  auth = createAuth({ users, sessions: new Sessions(secret, hours * 3600_000), trustProxy: env.AUDIT_TRUST_PROXY === '1', secureCookie: env.AUDIT_COOKIE_SECURE === '1' });
  log.info(`inicio de sesión activo (${users.length} usuario(s), sesión de ${hours} h)`);
}

const poller = new AuditPoller(cfg);
const office = new N8nOffice(poller, { version, baseUrl: cfg?.baseUrl ?? '', demo: cfg?.demo ?? false });
const hub = new Hub(office);
const api = createApi({ office, hub, poller, version, demo: cfg?.demo ?? false });
const guard = createRequestGuard({ allowedHosts: parseAllowedHosts(env.AUDIT_ALLOWED_HOSTS) });

const server = http.createServer();

let closeVite: (() => Promise<void>) | undefined;
let fallback: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;
if (dev) {
  // Import dinámico: el bundle de producción nunca carga Vite.
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: join(rootDir, 'vite.config.ts'), server: { middlewareMode: true, ws: { server } }, appType: 'spa' });
  closeVite = () => vite.close();
  fallback = (req, res) => vite.middlewares(req, res);
} else {
  const serveStatic = createStaticHandler(join(rootDir, 'dist', 'client'));
  fallback = (req, res, url) => serveStatic(req, res, url.pathname);
}

server.on('request', (req, res) => {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    url = new URL('/', 'http://localhost');
  }
  try {
    if (guard(req, res)) return;
    // Sin sesión no se sirve nada (ni la página ni la API) salvo /login y /api/health.
    if (auth && (auth.handle(req, res, url) || !auth.allowed(req, res, url))) return;
    if (!api(req, res, url)) fallback(req, res, url);
  } catch (err) {
    log.warn(`error al responder ${req.method} ${url.pathname}: ${errMsg(err)}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'error interno' });
    else res.destroy();
  }
});

hub.start();
poller.start();
server.listen(port, host, () => {
  log.info(`tablero de auditoría ${version}${dev ? ' (dev)' : ''}${cfg?.demo ? ' (demo)' : ''} en http://${host}:${port}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  log.error(err.code === 'EADDRINUSE' ? `el puerto ${port} ya está en uso (cambia PORT)` : `servidor: ${errMsg(err)}`);
  process.exit(1);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  poller.stop();
  hub.stop();
  void Promise.resolve(closeVite?.()).finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
