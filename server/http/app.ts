// Rutas HTTP de la auditoría. Solo lectura: GET. Todo lo demás bajo /api responde 404 (el cliente heredado de Habblaud
// pregunta por terminal, mensajes, World, etc.; aquí esas funciones no existen).
//
//   GET /api/health                       → { ok, version, demo, audit: status }
//   GET /api/access                       → AccessInfo (todo apagado salvo `local`)
//   GET /api/snapshot                     → OfficeSnapshot (incluye `audit`)
//   GET /api/stream                       → SSE: snapshot | feed | notice
//   GET /api/audit[?desde=&hasta=]        → AuditSnapshot (sin parámetros: el del sondeo; con ellos: consulta puntual a n8n)
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccessInfo, OfficeSnapshot } from '../../shared/types';
import { AuditFetchError, isIsoDay } from '../audit/client';
import type { AuditPoller } from '../audit/poller';
import type { N8nOffice } from '../model/n8n-office';
import { isLoopbackHost } from './guard';

/**
 * De dónde sale el snapshot. El servidor normal usa el Hub (SSE: además puede abrir /api/stream); en Vercel no hay
 * proceso permanente ni SSE, así que solo existe `current` y la página consulta /api/snapshot cada pocos segundos.
 */
export interface SnapshotSource {
  current(): OfficeSnapshot;
  attach?(req: IncomingMessage, res: ServerResponse): void;
}

export interface ApiDeps {
  office: N8nOffice;
  hub: SnapshotSource;
  poller: AuditPoller;
  version: string;
  demo: boolean;
}

/** Las consultas con rango propio llegan a n8n: se guardan unos segundos para que un panel abierto no lo martille. */
const QUERY_TTL_MS = 15_000;
const QUERY_CACHE_MAX = 20;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

export function createApi(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const cache = new Map<string, { at: number; body: unknown }>();

  return (req, res, url) => {
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (!read) {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, { error: 'método no permitido' });
      return true;
    }

    if (path === '/api/health') {
      sendJson(res, 200, { ok: true, version: deps.version, demo: deps.demo, audit: deps.poller.snapshot().status });
      return true;
    }
    if (path === '/api/access') {
      const local = isLoopbackHost(req.headers.host);
      // `polling`: sin SSE (Vercel), la página consulta /api/snapshot periódicamente en vez de abrir /api/stream.
      const access: AccessInfo = { remote: false, local, permissions: false, messages: false, terminal: false, spawn: false, world: false, ...(deps.hub.attach ? {} : { polling: true }) };
      sendJson(res, 200, access);
      return true;
    }
    if (path === '/api/snapshot') {
      sendJson(res, 200, deps.hub.current());
      return true;
    }
    if (path === '/api/stream') {
      if (deps.hub.attach) deps.hub.attach(req, res);
      else sendJson(res, 404, { error: 'tiempo real no disponible en este servidor: usa /api/snapshot' });
      return true;
    }
    if (path === '/api/audit') {
      const desde = url.searchParams.get('desde') ?? undefined;
      const hasta = url.searchParams.get('hasta') ?? undefined;
      if ((desde !== undefined && !isIsoDay(desde)) || (hasta !== undefined && !isIsoDay(hasta))) {
        sendJson(res, 400, { error: 'desde y hasta deben ser fechas YYYY-MM-DD' });
        return true;
      }
      if (desde && hasta && desde > hasta) {
        sendJson(res, 400, { error: 'desde no puede ser posterior a hasta' });
        return true;
      }
      if (!desde && !hasta) {
        sendJson(res, 200, deps.poller.snapshot());
        return true;
      }
      const key = `${desde ?? ''}|${hasta ?? ''}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < QUERY_TTL_MS) {
        sendJson(res, 200, hit.body);
        return true;
      }
      deps.poller.query({ desde, hasta }).then(
        (body) => {
          cache.set(key, { at: Date.now(), body });
          if (cache.size > QUERY_CACHE_MAX) cache.delete(cache.keys().next().value as string);
          sendJson(res, 200, body);
        },
        (e) => sendJson(res, 502, { error: e instanceof AuditFetchError ? e.message : 'no se pudo consultar n8n' }),
      );
      return true;
    }
    sendJson(res, 404, { error: 'no existe' });
    return true;
  };
}
