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
// Solo loopback por defecto: el tablero muestra datos de negocio y no tiene login.
const host = env.AUDIT_HOST || '127.0.0.1';

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
