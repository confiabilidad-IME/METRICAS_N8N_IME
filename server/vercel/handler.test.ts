import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth/passwords';
import { createHandler, FRESH_MS } from './handler';

const PASS = 'clave-de-prueba-123';
const SECRET = 's'.repeat(40);
const TOKEN = 'token-aud04-secreto';
const T0 = Date.parse('2026-11-05T15:00:00Z');

const aud04 = { generado_en: new Date(T0).toISOString(), rango: { desde: null, hasta: null }, metricas_diarias: [], ejecuciones_diarias: [], servicios: [{ workflow_id: 'w1', workflow_nombre: 'AUD01 - Metricas', activo: true, errores_24h: 0, actualizado_en: new Date(T0).toISOString() }], cotizaciones_definidas: [] };

let hash: string;
beforeAll(async () => {
  hash = await hashPassword(PASS);
});

interface Rig {
  base: string;
  calls: string[];
  clock: { now: number };
  fail: { on: boolean };
  close(): Promise<void>;
}

const open: Rig[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function rig(over: { env?: Record<string, string | undefined>; platform?: boolean } = {}): Promise<Rig> {
  const calls: string[] = [];
  const clock = { now: T0 };
  const fail = { on: false };
  const fetchImpl = (async (u: URL) => {
    calls.push(String(u.pathname + u.search));
    return fail.on ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(aud04));
  }) as unknown as typeof fetch;
  const env = { N8N_BASE_URL: 'https://n8n.test', N8N_AUDIT_TOKEN: TOKEN, AUDIT_SESSION_SECRET: SECRET, AUDIT_USERS: JSON.stringify([{ usuario: 'admin', hash }]), ...over.env };
  const handler = createHandler({ env, rootDir: '/nonexistent', fetchImpl, now: () => clock.now, platform: over.platform ?? true });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const r: Rig = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, clock, fail, close: () => new Promise((res) => server.close(() => res())) };
  open.push(r);
  return r;
}

/** Petición con Host a medida (fetch no deja cambiarlo). */
function request(r: Rig, path: string, o: { method?: string; host?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(r.base);
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = http.request({ host: u.hostname, port: u.port, path, method: o.method ?? 'GET', headers: { ...(o.host ? { host: o.host } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(r: Rig, host?: string): Promise<string> {
  const res = await request(r, '/api/login', { method: 'POST', host, body: { usuario: 'admin', password: PASS } });
  expect(res.status).toBe(200);
  return String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];
}

describe('función de Vercel', () => {
  it('sin sesión: la API responde 401, /login se sirve y /api/health queda abierto', async () => {
    const r = await rig();
    expect((await request(r, '/api/snapshot')).status).toBe(401);
    expect((await request(r, '/api/audit')).status).toBe(401);
    expect((await request(r, '/login')).status).toBe(200);
    expect((await request(r, '/api/health')).status).toBe(200);
    expect(r.calls).toEqual([]); // sin sesión no se consulta a n8n
  });

  it('con sesión: /api/access avisa polling, /api/stream no existe y /api/snapshot trae la auditoría', async () => {
    const r = await rig();
    const cookie = await login(r);
    expect(JSON.parse((await request(r, '/api/access', { cookie })).text)).toMatchObject({ polling: true });
    const stream = await request(r, '/api/stream', { cookie });
    expect(stream.status).toBe(404);
    const snap = await request(r, '/api/snapshot', { cookie });
    expect(snap.status).toBe(200);
    const body = JSON.parse(snap.text);
    expect(body.audit.status).toBe('ok');
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual(['w1']);
  });

  it('el token de AUD04 y la clave nunca salen en las respuestas', async () => {
    const r = await rig();
    const cookie = await login(r);
    for (const p of ['/api/snapshot', '/api/audit', '/api/access', '/api/health']) expect((await request(r, p, { cookie })).text).not.toContain(TOKEN);
  });

  it('caché: dos lecturas seguidas hacen una sola consulta a n8n; pasados 20 s, otra', async () => {
    const r = await rig();
    const cookie = await login(r);
    await request(r, '/api/snapshot', { cookie });
    await request(r, '/api/snapshot', { cookie });
    await request(r, '/api/audit', { cookie });
    expect(r.calls).toHaveLength(1);
    r.clock.now += FRESH_MS + 1000;
    await request(r, '/api/snapshot', { cookie });
    expect(r.calls).toHaveLength(2);
  });

  it('lecturas simultáneas comparten una sola consulta a n8n', async () => {
    const r = await rig();
    const cookie = await login(r);
    await Promise.all([1, 2, 3, 4].map(() => request(r, '/api/snapshot', { cookie })));
    expect(r.calls).toHaveLength(1);
  });

  it('un rango propio consulta a n8n con ese rango', async () => {
    const r = await rig();
    const cookie = await login(r);
    const res = await request(r, '/api/audit?desde=2026-10-01&hasta=2026-10-31', { cookie });
    expect(res.status).toBe(200);
    expect(r.calls[0]).toBe('/webhook/audit/metricas?desde=2026-10-01&hasta=2026-10-31');
  });

  it('si n8n falla responde igual (estado error) y reintenta en la siguiente lectura', async () => {
    const r = await rig();
    const cookie = await login(r);
    r.fail.on = true;
    const a = JSON.parse((await request(r, '/api/snapshot', { cookie })).text);
    expect(a.audit.status).toBe('error');
    r.fail.on = false;
    const b = JSON.parse((await request(r, '/api/snapshot', { cookie })).text);
    expect(b.audit.status).toBe('ok');
  });

  it('sin N8N_AUDIT_TOKEN el tablero abre con la auditoría "disabled" y no consulta nada', async () => {
    const r = await rig({ env: { N8N_AUDIT_TOKEN: undefined } });
    const cookie = await login(r);
    expect(JSON.parse((await request(r, '/api/snapshot', { cookie })).text).audit.status).toBe('disabled');
    expect(r.calls).toEqual([]);
  });

  it('en la plataforma acepta el host de la petición; fuera de ella rechaza hosts desconocidos (anti DNS rebinding)', async () => {
    const onPlatform = await rig({ platform: true });
    expect((await request(onPlatform, '/login', { host: 'metricasn8nime.vercel.app' })).status).toBe(200);
    const standalone = await rig({ platform: false });
    expect((await request(standalone, '/login', { host: 'metricasn8nime.vercel.app' })).status).toBe(403);
    const allowed = await rig({ platform: false, env: { AUDIT_ALLOWED_HOSTS: 'tablero.ime.com.co' } });
    expect((await request(allowed, '/login', { host: 'tablero.ime.com.co' })).status).toBe(200);
  });

  it('la cookie sale Secure detrás del proxy de la plataforma (HTTPS)', async () => {
    const r = await rig();
    const res = await request(r, '/api/login', { method: 'POST', body: { usuario: 'admin', password: PASS } });
    expect(res.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);
    const https = await new Promise<http.IncomingHttpHeaders>((resolve) => {
      const u = new URL(r.base);
      const body = JSON.stringify({ usuario: 'admin', password: PASS });
      const q = http.request({ host: u.hostname, port: u.port, path: '/api/login', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-forwarded-proto': 'https' } }, (rs) => {
        rs.resume();
        resolve(rs.headers);
      });
      q.end(body);
    });
    expect(https['set-cookie']?.[0]).toMatch(/; Secure/);
  });

  it('una sesión vencida deja de valer', async () => {
    const r = await rig({ env: { AUDIT_SESSION_HOURS: '1' } });
    const cookie = await login(r);
    expect((await request(r, '/api/access', { cookie })).status).toBe(200);
    r.clock.now += 61 * 60_000;
    expect((await request(r, '/api/access', { cookie })).status).toBe(401);
  });

  it('un POST a la API sin sesión no pasa', async () => {
    const r = await rig();
    expect((await request(r, '/api/demo', { method: 'POST', body: {} })).status).toBe(401);
  });
});

describe('errores de configuración (se explican, sin revelar valores)', () => {
  it('sin AUDIT_SESSION_SECRET: 500 con el motivo, en la API y en /login', async () => {
    const r = await rig({ env: { AUDIT_SESSION_SECRET: undefined } });
    const api = await request(r, '/api/snapshot');
    expect(api.status).toBe(500);
    expect(JSON.parse(api.text).error).toMatch(/AUDIT_SESSION_SECRET/);
    const page = await request(r, '/login');
    expect(page.status).toBe(500);
    expect(page.text).toMatch(/AUDIT_SESSION_SECRET/);
  });
  it('secreto demasiado corto = como si faltara', async () => {
    const r = await rig({ env: { AUDIT_SESSION_SECRET: 'corto' } });
    expect((await request(r, '/api/snapshot')).status).toBe(500);
  });
  it('sin usuarios: 500 (nunca queda abierto)', async () => {
    const r = await rig({ env: { AUDIT_USERS: undefined } });
    const res = await request(r, '/api/snapshot');
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/usuarios/);
  });
  it('AUDIT_USERS con JSON roto: 500 con el motivo', async () => {
    const r = await rig({ env: { AUDIT_USERS: '{no' } });
    expect((await request(r, '/api/snapshot')).text).toMatch(/AUDIT_USERS: JSON inválido/);
  });
  it('el mensaje de error nunca incluye la clave de sesión', async () => {
    const r = await rig({ env: { AUDIT_USERS: '{no' } });
    expect((await request(r, '/api/snapshot')).text).not.toContain(SECRET);
  });
});

describe('api/index.js', () => {
  it('está al día con server/vercel/handler.ts (si falla: npm run build:api y sube api/index.js)', async () => {
    const out = await build({ entryPoints: ['server/vercel/handler.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', legalComments: 'none', write: false, logLevel: 'silent', banner: { js: '// GENERADO por scripts/build-api.mjs desde server/vercel/handler.ts. No editar a mano.' } });
    const fresh = out.outputFiles[0].text.replace(/\r\n/g, '\n');
    const committed = readFileSync('api/index.js', 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(fresh);
  });
});
