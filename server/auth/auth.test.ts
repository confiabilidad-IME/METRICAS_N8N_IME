import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from './index';
import { AttemptLimiter } from './limiter';
import { hashPassword, isPasswordHash, verifyPassword } from './passwords';
import { parseCookies, Sessions } from './session';
import { loadUsers, parseUsers } from './users';

const PASS = 'clave-correcta-123';
const SECRET = Buffer.from('s'.repeat(40));

describe('passwords', () => {
  it('hash scrypt con sal propia: nunca contiene la contraseña y dos hashes de la misma clave difieren', async () => {
    const a = await hashPassword(PASS);
    const b = await hashPassword(PASS);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toContain(PASS);
    expect(a).not.toBe(b);
  });
  it('verifica la correcta y rechaza la errónea', async () => {
    const h = await hashPassword(PASS);
    expect(await verifyPassword(PASS, h)).toBe(true);
    expect(await verifyPassword(PASS + 'x', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });
  it('la misma contraseña con otra composición Unicode (ñ) coincide', async () => {
    const h = await hashPassword('contraseña-larga');
    expect(await verifyPassword('contraseña-larga'.replace('contraseña', 'contraseña'), h)).toBe(true);
  });
  it('un hash mal formado o con costo absurdo no valida (ni agota memoria)', async () => {
    for (const bad of ['', 'texto', 'scrypt$1$2$3', 'bcrypt$16384$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA', 'scrypt$1073741824$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA', 'scrypt$3$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA']) {
      expect(isPasswordHash(bad)).toBe(false);
      expect(await verifyPassword(PASS, bad)).toBe(false);
    }
  });
});

describe('usuarios', () => {
  let hash: string;
  let dir: string;
  beforeAll(async () => {
    hash = await hashPassword(PASS);
    dir = mkdtempSync(join(tmpdir(), 'audit-users-'));
  });

  it('valida nombres y hashes: mejor no arrancar que arrancar sin login', () => {
    expect(() => parseUsers([{ usuario: 'a', hash }], 'x')).toThrow(/nombre inválido/);
    expect(() => parseUsers([{ usuario: 'ok', hash: 'plano' }], 'x')).toThrow(/hash scrypt/);
    expect(() => parseUsers({}, 'x')).toThrow(/lista/);
    expect(parseUsers([{ usuario: '  Maria ', hash }], 'x')[0].name).toBe('maria');
  });
  it('combina por capas: por defecto < users.json < AUDIT_USERS, y disabled desactiva', async () => {
    const h2 = await hashPassword('otra-clave-456');
    writeFileSync(join(dir, 'users.default.json'), JSON.stringify([{ usuario: 'admin', hash }, { usuario: 'gerencia', hash }]));
    writeFileSync(join(dir, 'users.json'), JSON.stringify([{ usuario: 'admin', hash: h2 }, { usuario: 'gerencia', disabled: true }]));
    const base = loadUsers({}, dir);
    expect(base.map((u) => u.name)).toEqual(['admin']);
    expect(base[0].hash).toBe(h2);
    const withEnv = loadUsers({ AUDIT_USERS: JSON.stringify([{ usuario: 'nuevo', hash }]) }, dir);
    expect(withEnv.map((u) => u.name).sort()).toEqual(['admin', 'nuevo']);
  });
  it('AUDIT_USERS con JSON roto o sin archivos no pasa en silencio', () => {
    expect(() => loadUsers({ AUDIT_USERS: '{no' }, dir)).toThrow(/JSON inválido/);
    const vacio = mkdtempSync(join(tmpdir(), 'audit-empty-'));
    expect(loadUsers({}, vacio)).toEqual([]);
    mkdirSync(join(vacio, 'x'), { recursive: true });
  });
});

describe('sesiones', () => {
  it('firma y verifica; un token manipulado, de otro secreto o vencido no vale', () => {
    let now = 1_000_000;
    const s = new Sessions(SECRET, 60_000, () => now);
    const t = s.issue('admin');
    expect(s.verify(t)).toBe('admin');
    const [payload, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'root', e: now + 1e9 })).toString('base64url');
    expect(s.verify(`${forged}.${mac}`)).toBeNull();
    expect(s.verify(`${payload}.${mac.slice(0, -2)}AA`)).toBeNull();
    expect(new Sessions(Buffer.from('z'.repeat(40)), 60_000, () => now).verify(t)).toBeNull();
    now += 61_000;
    expect(s.verify(t)).toBeNull();
  });
  it('basura y entradas extremas devuelven null sin lanzar', () => {
    const s = new Sessions(SECRET, 60_000);
    for (const v of [undefined, '', '.', 'a.b', 'x'.repeat(600), '###.###']) expect(s.verify(v)).toBeNull();
  });
  it('parseCookies ignora entradas mal formadas y conserva la primera repetida', () => {
    expect(parseCookies('a=1; b=2; =x; c; a=9')).toEqual({ a: '1', b: '2' });
  });
});

describe('limitador de intentos', () => {
  it('bloquea al llegar al máximo, informa cuánto esperar y se libera al vencer la ventana', () => {
    let now = 0;
    const l = new AttemptLimiter(3, 1000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(l.retryAfter('k')).toBe(0);
      l.fail('k');
    }
    expect(l.retryAfter('k')).toBe(1);
    expect(l.retryAfter('otro')).toBe(0);
    now = 1001;
    expect(l.retryAfter('k')).toBe(0);
  });
  it('reset limpia el contador', () => {
    const l = new AttemptLimiter(1, 1000);
    l.fail('k');
    l.reset('k');
    expect(l.retryAfter('k')).toBe(0);
  });
});

describe('servidor con login', () => {
  let hash: string;
  let server: http.Server;
  let base: string;
  const sessions = new Sessions(SECRET, 3_600_000);

  function start(users: { name: string; hash: string }[], extra: { trustProxy?: boolean } = {}, maxAttempts = 5): Promise<http.Server> {
    const auth = createAuth({ users, sessions, maxAttempts, ...extra });
    const s = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (auth.handle(req, res, url)) return;
      if (!auth.allowed(req, res, url)) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(url.pathname === '/api/health' ? 'ok' : 'contenido privado');
    });
    return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
  }
  const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, b = base) =>
    fetch(b + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  const cookieOf = (r: Response): string => (r.headers.get('set-cookie') ?? '').split(';')[0];

  beforeAll(async () => {
    hash = await hashPassword(PASS);
    server = await start([{ name: 'admin', hash }]);
    base = url(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sin sesión: las páginas redirigen a /login y la API responde 401; /api/health queda abierto', async () => {
    const page = await fetch(base + '/', { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/login');
    const api = await fetch(base + '/api/audit');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'no autenticado' });
    expect((await post('/api/algo', {})).status).toBe(401);
    expect(await (await fetch(base + '/api/health')).text()).toBe('ok');
  });

  it('/login sirve la página con CSP estricto y sin caché', async () => {
    const r = await fetch(base + '/login');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'.*script-src 'sha256-/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(await r.text()).toContain('type="password"');
  });

  it('contraseña errónea y usuario inexistente dan exactamente la misma respuesta', async () => {
    const wrong = await post('/api/login', { usuario: 'admin', password: 'mala-contraseña' });
    const unknown = await post('/api/login', { usuario: 'fantasma', password: 'mala-contraseña' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('login correcto: cookie HttpOnly + SameSite, sin la contraseña en ninguna parte, y abre el acceso', async () => {
    const r = await post('/api/login', { usuario: ' ADMIN ', password: PASS });
    expect(r.status).toBe(200);
    const raw = r.headers.get('set-cookie') ?? '';
    expect(raw).toMatch(/^audit_session=/);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).not.toMatch(/Secure/); // http local
    expect(raw + JSON.stringify(await r.json())).not.toContain(PASS);
    const cookie = cookieOf(r);
    expect(await (await fetch(base + '/', { headers: { cookie } })).text()).toBe('contenido privado');
    expect(await (await fetch(base + '/api/session', { headers: { cookie } })).json()).toEqual({ usuario: 'admin', rol: 'admin' });
    const again = await fetch(base + '/login', { headers: { cookie }, redirect: 'manual' });
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe('/');
  });

  it('cerrar sesión borra la cookie', async () => {
    const r = await post('/api/logout', {});
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/audit_session=; .*Max-Age=0/);
  });

  it('una cookie manipulada no abre nada', async () => {
    const ok = cookieOf(await post('/api/login', { usuario: 'admin', password: PASS }));
    const bad = ok.slice(0, -3) + 'AAA';
    expect((await fetch(base + '/', { headers: { cookie: bad }, redirect: 'manual' })).status).toBe(302);
    expect((await fetch(base + '/api/audit', { headers: { cookie: 'audit_session=basura' } })).status).toBe(401);
  });

  it('solicitudes inválidas: JSON roto, campos ausentes o de tipo erróneo -> 400; método erróneo -> 405', async () => {
    expect((await post('/api/login', '{no json')).status).toBe(400);
    expect((await post('/api/login', { usuario: 'admin' })).status).toBe(400);
    expect((await post('/api/login', { usuario: 1, password: 2 })).status).toBe(400);
    expect((await post('/api/login', { usuario: 'a'.repeat(100), password: 'x' })).status).toBe(400);
    expect((await fetch(base + '/api/login')).status).toBe(405);
  });

  it('fuerza bruta: tras 5 fallos el usuario queda bloqueado (429 + Retry-After) aunque luego acierte', async () => {
    const s = await start([{ name: 'admin', hash }]);
    const b = url(s);
    for (let i = 0; i < 5; i++) expect((await post('/api/login', { usuario: 'admin', password: 'mala' + i }, {}, b)).status).toBe(401);
    const blocked = await post('/api/login', { usuario: 'admin', password: PASS }, {}, b);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // otro usuario desde la misma IP no está bloqueado por el límite por usuario
    expect((await post('/api/login', { usuario: 'otro', password: 'x' }, {}, b)).status).toBe(401);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('si el usuario se da de baja, su cookie vigente deja de valer', async () => {
    const cookie = cookieOf(await post('/api/login', { usuario: 'admin', password: PASS }));
    const s2 = await start([{ name: 'otro', hash }]); // mismo secreto de sesión, sin "admin"
    const r = await fetch(url(s2) + '/api/audit', { headers: { cookie } });
    expect(r.status).toBe(401);
    await new Promise<void>((r2) => s2.close(() => r2()));
  });

  it('detrás de un proxy de confianza, la cookie sale Secure con X-Forwarded-Proto https; sin confianza se ignora', async () => {
    const trusted = await start([{ name: 'admin', hash }], { trustProxy: true });
    const r1 = await post('/api/login', { usuario: 'admin', password: PASS }, { 'x-forwarded-proto': 'https' }, url(trusted));
    expect(r1.headers.get('set-cookie')).toMatch(/; Secure/);
    const plain = await start([{ name: 'admin', hash }]);
    const r2 = await post('/api/login', { usuario: 'admin', password: PASS }, { 'x-forwarded-proto': 'https' }, url(plain));
    expect(r2.headers.get('set-cookie')).not.toMatch(/Secure/);
    await new Promise<void>((r) => trusted.close(() => r()));
    await new Promise<void>((r) => plain.close(() => r()));
  });

  it('un cuerpo enorme no tumba el servidor', async () => {
    await post('/api/login', 'x'.repeat(50_000)).catch(() => undefined);
    expect((await fetch(base + '/api/health')).status).toBe(200);
  });
});
