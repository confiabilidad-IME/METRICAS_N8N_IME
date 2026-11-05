import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditData, AuditService } from '../../shared/audit';
import { computeKpis, deriveAlerts } from '../audit/derive';
import { AuditPoller } from '../audit/poller';
import { createApi } from '../http/app';
import { Hub } from '../http/sse';
import { alarmText, N8nOffice, ROOM_ID, shortName } from './n8n-office';

const TOKEN = 'token-que-no-debe-salir';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const config = { baseUrl: 'https://n8n.test', webhookPath: '/w', token: TOKEN, timezone: 'UTC', pollIntervalMs: 60_000, requestTimeoutMs: 1000, rangeDays: 30, port: 3000, demo: false };

const svc = (id: string, over: Partial<AuditService> = {}): AuditService => ({
  workflow_id: id,
  workflow_nombre: `AUD0${id} - Algo`,
  activo: true,
  errores_24h: 0,
  actualizado_en: new Date(NOW - 60_000).toISOString(),
  ...over,
});
const data = (servicios: AuditService[]): AuditData => ({ generado_en: new Date(NOW).toISOString(), rango: { desde: null, hasta: null }, metricas_diarias: [], ejecuciones_diarias: [], servicios, cotizaciones_definidas: [] });

function setup(initial: AuditData) {
  let body = initial;
  let clock = NOW;
  const f = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const poller = new AuditPoller(config, { fetchImpl: f, now: () => clock });
  const office = new N8nOffice(poller, { version: '1.2.3', baseUrl: config.baseUrl, demo: false, now: () => clock });
  return {
    poller,
    office,
    set: (d: AuditData) => (body = d),
    tick: (ms: number) => (clock += ms),
  };
}

describe('shortName', () => {
  it('usa el código AUDxx / WFxx y recorta nombres largos', () => {
    expect(shortName('AUD03 - Auditoria de ejecuciones')).toBe('AUD03');
    expect(shortName('wf06 - Motor')).toBe('WF06');
    expect(shortName('Etiquetado_cotizacion_muy_largo')).toBe('Etiquetado_coti…');
    expect(shortName('Etiquetado_gerencia')).toBe('Etiquetado_gere…');
  });
});

describe('N8nOffice', () => {
  it('un personaje por flujo activo; los inactivos no aparecen', async () => {
    const t = setup(data([svc('1'), svc('2', { activo: false })]));
    await t.poller.refresh();
    const { snapshot } = t.office.commit();
    expect(snapshot.agents.map((a) => a.id)).toEqual(['1']);
    expect(snapshot.rooms).toHaveLength(1);
    expect(snapshot.rooms[0].id).toBe(ROOM_ID);
    expect(snapshot.agents[0].roomId).toBe(ROOM_ID);
  });

  it('mapea estados: fallo -> waiting + alarma; ejecución reciente -> working; resto -> idle', async () => {
    const reciente = new Date(NOW - 60_000).toISOString();
    const vieja = new Date(NOW - 3 * 3600_000).toISOString();
    const t = setup(data([svc('1', { estado_ultima: 'error', ultima_ejecucion: reciente }), svc('2', { estado_ultima: 'success', ultima_ejecucion: reciente }), svc('3', { estado_ultima: 'success', ultima_ejecucion: vieja })]));
    await t.poller.refresh();
    const { snapshot } = t.office.commit();
    const by = Object.fromEntries(snapshot.agents.map((a) => [a.id, a]));
    expect(by['1'].status).toBe('waiting');
    expect(by['1'].waitingFor).toBeTruthy();
    expect(by['2'].status).toBe('working');
    expect(by['3'].status).toBe('idle');
    expect(snapshot.rooms[0].effect?.kind).toBe('alarm');
  });

  it('sin errores no hay alarma, y el snapshot trae la auditoría', async () => {
    const t = setup(data([svc('1', { estado_ultima: 'success' })]));
    await t.poller.refresh();
    const { snapshot } = t.office.commit();
    expect(snapshot.rooms[0].effect).toBeUndefined();
    expect(snapshot.audit?.status).toBe('ok');
    expect(snapshot.meta).toMatchObject({ version: '1.2.3', demo: false });
  });

  it('nombres repetidos se desambiguan', async () => {
    const t = setup(data([svc('1', { workflow_nombre: 'AUD01 - a' }), svc('2', { workflow_nombre: 'AUD01 - b' })]));
    await t.poller.refresh();
    const names = t.office.commit().snapshot.agents.map((a) => a.name);
    expect(new Set(names).size).toBe(2);
  });

  it('commit sin cambios no sube rev ni repite feed', async () => {
    const t = setup(data([svc('1')]));
    await t.poller.refresh();
    const a = t.office.commit();
    const b = t.office.commit();
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(false);
    expect(b.snapshot.rev).toBe(a.snapshot.rev);
  });

  it('no inunda el feed ni los avisos en la primera carga; después avisa solo lo nuevo', async () => {
    const t = setup(data([svc('1', { estado_ultima: 'error', ultima_ejecucion: new Date(NOW - 1000).toISOString() })]));
    await t.poller.refresh();
    const first = t.office.commit();
    expect(first.feed).toEqual([]);
    expect(first.notices).toEqual([]);

    // nueva ejecución del flujo 1 y un segundo flujo que empieza a fallar
    t.tick(60_000);
    t.set(data([svc('1', { estado_ultima: 'error', ultima_ejecucion: new Date(NOW + 30_000).toISOString() }), svc('2', { estado_ultima: 'error', ultima_ejecucion: new Date(NOW + 40_000).toISOString() })]));
    await t.poller.refresh();
    const second = t.office.commit();
    expect(second.feed.map((f) => f.agentId)).toEqual(['1']);
    expect(second.notices.map((n) => n.agentId)).toEqual(['2']);
    expect(t.office.recentFeed(10)).toHaveLength(1);

    // misma foto otra vez: nada nuevo
    t.tick(60_000);
    await t.poller.refresh();
    const third = t.office.commit();
    expect(third.notices).toEqual([]);
  });

  it('desactivada: sala vacía y estado disabled, sin romper', () => {
    const poller = new AuditPoller(null);
    const office = new N8nOffice(poller, { version: '1', baseUrl: '', demo: false, now: () => NOW });
    const { snapshot } = office.commit();
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.rooms).toEqual([]);
    expect(snapshot.audit?.status).toBe('disabled');
  });
});

describe('API HTTP', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function boot(initial: AuditData) {
    const t = setup(initial);
    await t.poller.refresh();
    const hub = new Hub(t.office, { throttleMs: 0, pingMs: 60_000 });
    hub.start();
    const api = createApi({ office: t.office, hub, poller: t.poller, version: '1', demo: false });
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!api(req, res, url)) {
        res.writeHead(404);
        res.end('static');
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, hub, ...t };
  }

  it('/api/audit devuelve el snapshot del sondeo sin exponer el token', async () => {
    const { base, hub } = await boot(data([svc('1')]));
    for (const p of ['/api/audit', '/api/snapshot', '/api/health', '/api/access']) {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      expect(await r.text()).not.toContain(TOKEN);
    }
    hub.stop();
  });

  it('valida el rango antes de tocar n8n', async () => {
    const { base, hub } = await boot(data([svc('1')]));
    expect((await fetch(`${base}/api/audit?desde=ayer`)).status).toBe(400);
    expect((await fetch(`${base}/api/audit?desde=2026-02-30`)).status).toBe(400);
    expect((await fetch(`${base}/api/audit?desde=2026-11-10&hasta=2026-11-01`)).status).toBe(400);
    hub.stop();
  });

  it('un rango válido consulta n8n y devuelve ese rango', async () => {
    const { base, hub } = await boot(data([svc('1')]));
    const r = await fetch(`${base}/api/audit?desde=2026-10-01&hasta=2026-10-31`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ok', desde: '2026-10-01', hasta: '2026-10-31' });
    hub.stop();
  });

  it('solo lectura: POST -> 405; rutas de funciones que no existen -> 404 JSON', async () => {
    const { base, hub } = await boot(data([svc('1')]));
    expect((await fetch(`${base}/api/audit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405);
    for (const p of ['/api/world/status', '/api/spawn', '/api/messages', '/api/pty']) expect((await fetch(base + p)).status).toBe(404);
    expect(await (await fetch(`${base}/api/world/status`)).json()).toEqual({ error: 'no existe' });
    hub.stop();
  });

  it('access: nada habilitado (sin terminal, mensajes, permisos, spawn ni World)', async () => {
    const { base, hub } = await boot(data([svc('1')]));
    expect(await (await fetch(`${base}/api/access`)).json()).toMatchObject({ remote: false, permissions: false, messages: false, terminal: false, spawn: false, world: false });
    hub.stop();
  });

  it('/api/stream manda snapshot (con auditoría) y feed al conectar', async () => {
    const { base, hub } = await boot(data([svc('1')]));
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: feed')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"audit"');
    expect(text).not.toContain(TOKEN);
    ctrl.abort();
    hub.stop();
  });
});

describe('alarma con nombre', () => {
  it('nombra el flujo con error en la faja de la sala, en su actividad y en la alerta', () => {
    const iso = new Date(NOW - 1000).toISOString();
    const servicio = svc('1', { workflow_nombre: 'AUD03 - Auditoria', estado_ultima: 'error', ultima_ejecucion: iso, ultimo_error: { execution_id: '9', at: iso, nodo: 'Listar workflows', mensaje: 'HTTP 404' } });
    const d = data([servicio]);
    // poller simulado: el detalle del error solo lo añade la API en vivo, no AUD04
    const poller = { snapshot: () => ({ status: 'ok', fetchedAt: NOW, desde: '2026-10-05', data: d, kpis: computeKpis(d), alertas: deriveAlerts(d, NOW) }), onChange: () => () => {} } as unknown as AuditPoller;
    const { snapshot } = new N8nOffice(poller, { version: '1', baseUrl: '', demo: false, now: () => NOW }).commit();
    expect(snapshot.rooms[0].effect?.text).toBe('Error en AUD03');
    expect(snapshot.agents[0].activity?.detail).toContain('Listar workflows');
    expect(snapshot.audit?.alertas[0].text).toContain('Listar workflows');
  });
  it('con varios, muestra dos nombres y cuántos más', () => {
    const f = (n: string) => svc(n, { workflow_nombre: `AUD0${n} - x`, estado_ultima: 'error' });
    expect(alarmText([f('1'), f('2')])).toBe('Error en AUD01 y AUD02');
    expect(alarmText([f('1'), f('2'), f('3'), f('4')])).toBe('Error en AUD01, AUD02 y 2 más');
  });
});
