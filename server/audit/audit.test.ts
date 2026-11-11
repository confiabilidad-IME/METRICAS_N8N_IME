import { describe, expect, it } from 'vitest';
import type { AuditData } from '../../shared/audit';
import { AuditFetchError, fetchAudit, isIsoDay, normalizeAudit } from './client';
import { parseEnvFile, readAuditConfig } from './config';
import { demoAudit } from './demo';
import { addDays, computeKpis, dayIn, deriveAlerts, SERVICES_STALE_MS } from './derive';
import { AuditPoller } from './poller';

const TOKEN = 'super-secreto-123';
const cfg = { baseUrl: 'https://n8n.test', webhookPath: '/webhook/audit/metricas', token: TOKEN, requestTimeoutMs: 1000 };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base = (over: Partial<AuditData> = {}): AuditData => ({
  generado_en: '2026-11-04T12:00:00.000Z',
  rango: { desde: '2026-11-01', hasta: null },
  metricas_diarias: [],
  ejecuciones_diarias: [],
  servicios: [],
  cotizaciones_definidas: [],
  ...over,
});

describe('config', () => {
  it('parsea .env con comentarios y comillas', () => {
    expect(parseEnvFile('# c\nA=1\nB="dos palabras"\nC=3 # nota\n\nmal linea\n1X=no')).toEqual({ A: '1', B: 'dos palabras', C: '3' });
  });
  it('queda desactivada sin URL o token, salvo en demo', () => {
    expect(readAuditConfig({})).toBeNull();
    expect(readAuditConfig({ N8N_BASE_URL: 'https://x.test' })).toBeNull();
    expect(readAuditConfig({ AUDIT_DEMO: '1' })?.demo).toBe(true);
  });
  it('normaliza URL, ruta y límites', () => {
    const c = readAuditConfig({ N8N_BASE_URL: 'https://x.test//', N8N_AUDIT_TOKEN: 't', N8N_AUDIT_WEBHOOK_PATH: 'webhook/a', POLL_INTERVAL_SECONDS: '1', APP_TIMEZONE: 'No/Existe' });
    expect(c).toMatchObject({ baseUrl: 'https://x.test', webhookPath: '/webhook/a', pollIntervalMs: 60_000, timezone: 'America/Bogota' });
  });
  it('rechaza una URL que no es http(s)', () => {
    expect(readAuditConfig({ N8N_BASE_URL: 'ftp://x', N8N_AUDIT_TOKEN: 't' })).toBeNull();
  });
});

describe('normalizeAudit', () => {
  it('convierte números en texto y cae en 0 con basura', () => {
    const d = normalizeAudit({ metricas_diarias: [{ fecha: '2026-11-03T00:00:00Z', ganadas: '4', perdidas: 'x', valor_ganado: '1200.5' }] });
    expect(d.metricas_diarias[0]).toMatchObject({ fecha: '2026-11-03', ganadas: 4, perdidas: 0, valor_ganado: 1200.5 });
  });
  it('acepta la respuesta envuelta en un arreglo y ordena por fecha', () => {
    const d = normalizeAudit([{ metricas_diarias: [{ fecha: '2026-11-03' }, { fecha: '2026-11-01' }] }]);
    expect(d.metricas_diarias.map((m) => m.fecha)).toEqual(['2026-11-01', '2026-11-03']);
  });
  it('descarta filas sin id y entiende activo como texto', () => {
    const d = normalizeAudit({ servicios: [{ workflow_id: 'a', activo: 'true' }, { workflow_nombre: 'sin id' }] });
    expect(d.servicios).toHaveLength(1);
    expect(d.servicios[0].activo).toBe(true);
  });
  it('rechaza lo que no parece AUD04', () => {
    expect(() => normalizeAudit({ hola: 1 })).toThrow(AuditFetchError);
    expect(() => normalizeAudit(null)).toThrow(AuditFetchError);
    expect(() => normalizeAudit('texto')).toThrow(AuditFetchError);
  });
});

describe('fetchAudit', () => {
  it('manda el token por header, nunca en la URL', async () => {
    let seen: { url: string; headers: Headers } | undefined;
    const f = (async (url: URL, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers) };
      return json({ servicios: [] });
    }) as unknown as typeof fetch;
    await fetchAudit(cfg, { desde: '2026-11-01', hasta: '2026-11-04' }, f);
    expect(seen?.headers.get('x-audit-token')).toBe(TOKEN);
    expect(seen?.url).toBe('https://n8n.test/webhook/audit/metricas?desde=2026-11-01&hasta=2026-11-04');
    expect(seen?.url).not.toContain(TOKEN);
  });
  it('ignora fechas inválidas en vez de reenviarlas a n8n', async () => {
    let url = '';
    const f = (async (u: URL) => ((url = String(u)), json({ servicios: [] }))) as unknown as typeof fetch;
    await fetchAudit(cfg, { desde: '2026-13-45', hasta: "x'; drop" }, f);
    expect(url).toBe('https://n8n.test/webhook/audit/metricas');
  });
  it.each([
    [401, /rechazado/],
    [404, /no encontrado|inactivo/],
    [500, /500/],
  ])('traduce HTTP %i a un mensaje sin el token', async (status, re) => {
    const f = (async () => json({ error: TOKEN }, status)) as unknown as typeof fetch;
    const err = await fetchAudit(cfg, {}, f).catch((e: AuditFetchError) => e);
    expect(err).toBeInstanceOf(AuditFetchError);
    expect((err as AuditFetchError).message).toMatch(re);
    expect((err as AuditFetchError).message).not.toContain(TOKEN);
  });
  it('maneja red caída, timeout y cuerpo que no es JSON', async () => {
    const down = (async () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    }) as unknown as typeof fetch;
    const e1 = await fetchAudit(cfg, {}, down).catch((e: Error) => e);
    expect((e1 as Error).message).toBe('no se pudo conectar con n8n');
    const slow = (async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(((await fetchAudit(cfg, {}, slow).catch((e: Error) => e)) as Error).message).toMatch(/a tiempo/);
    const html = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(((await fetchAudit(cfg, {}, html).catch((e: Error) => e)) as Error).message).toMatch(/JSON/);
  });
});

describe('fechas', () => {
  it('usa la zona horaria configurada (23:30 en Bogotá ya es el día siguiente en UTC)', () => {
    const at = Date.parse('2026-11-05T04:30:00Z'); // 23:30 del 4 en Bogotá (UTC-5)
    expect(dayIn('America/Bogota', at)).toBe('2026-11-04');
    expect(dayIn('UTC', at)).toBe('2026-11-05');
  });
  it('suma días cruzando mes y año', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('valida días reales', () => {
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay(undefined)).toBe(false);
  });
});

describe('computeKpis', () => {
  const day = (fecha: string, over = {}) => ({ ...demoAudit(0, 'UTC').metricas_diarias[0], fecha, ...over });
  it('toma el acumulado de la última foto y NO lo suma entre días', () => {
    const k = computeKpis(base({ metricas_diarias: [day('2026-11-01', { definidas_total: 10, ganadas: 6, perdidas: 4, valor_ganado: 600 }), day('2026-11-02', { definidas_total: 12, ganadas: 7, perdidas: 5, valor_ganado: 700 })] }));
    expect(k).toMatchObject({ definidasAcum: 12, ganadasAcum: 7, perdidasAcum: 5, valorGanadoAcum: 700, fotoFecha: '2026-11-02' });
    expect(k.tasaCierreAcum).toBeCloseTo(7 / 12, 3);
  });
  it('suma solo las cifras que son del día', () => {
    const k = computeKpis(base({ metricas_diarias: [day('2026-11-01', { correos_enviados: 5, seguimientos_enviados: 1 }), day('2026-11-02', { correos_enviados: 7, seguimientos_enviados: 2 })] }));
    expect(k).toMatchObject({ correosEnviados: 12, seguimientosEnviados: 3 });
  });
  it('el período sale de las cotizaciones definidas', () => {
    const q = (id: string, r: 'GANADA' | 'PERDIDA', valor: number) => ({ cotizacion_id: id, resultado_final: r, valor });
    const k = computeKpis(base({ cotizaciones_definidas: [q('a', 'GANADA', 100), q('b', 'GANADA', 50), q('c', 'PERDIDA', 30)] }));
    expect(k).toMatchObject({ definidasPeriodo: 3, ganadasPeriodo: 2, perdidasPeriodo: 1, valorGanadoPeriodo: 150, valorPerdidoPeriodo: 30 });
    expect(k.tasaCierrePeriodo).toBeCloseTo(2 / 3, 3);
  });
  it('sin datos no inventa tasas ni divide por cero', () => {
    const k = computeKpis(base());
    expect(k.tasaCierrePeriodo).toBeNull();
    expect(k.tasaCierreAcum).toBeNull();
    expect(k.fotoFecha).toBeNull();
  });
});

describe('deriveAlerts', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const fresh = new Date(now - 60_000).toISOString();
  const svc = (over = {}) => ({ workflow_id: 'w1', workflow_nombre: 'AUD02', activo: true, errores_24h: 0, actualizado_en: fresh, ...over });

  it('sin problemas no hay alertas', () => {
    expect(deriveAlerts(base({ servicios: [svc()] }), now)).toEqual([]);
  });
  it('última ejecución fallida es alerta; errores de 24 h es advertencia', () => {
    const a = deriveAlerts(base({ servicios: [svc({ estado_ultima: 'error' }), svc({ workflow_id: 'w2', errores_24h: 3 })] }), now);
    expect(a.map((x) => [x.id, x.level])).toEqual([
      ['ultima-fallida:w1', 'alert'],
      ['errores-24h:w2', 'warn'],
    ]);
  });
  it('los flujos inactivos no generan alertas', () => {
    expect(deriveAlerts(base({ servicios: [svc({ activo: false, estado_ultima: 'error', errores_24h: 9 })] }), now)).toEqual([]);
  });
  it('conserva `since` de una alerta que sigue vigente', () => {
    const data = base({ servicios: [svc({ estado_ultima: 'crashed' })] });
    const first = deriveAlerts(data, now);
    const again = deriveAlerts(data, now + 600_000, first);
    expect(again[0].since).toBe(first[0].since);
  });
  it('avisa si AUD03 dejó de actualizar los servicios, o si la tabla está vacía', () => {
    const old = new Date(now - SERVICES_STALE_MS - 1000).toISOString();
    expect(deriveAlerts(base({ servicios: [svc({ actualizado_en: old })] }), now).map((a) => a.id)).toContain('servicios-desactualizados:global');
    expect(deriveAlerts(base(), now).map((a) => a.id)).toContain('servicios-vacio:global');
  });
  it('avisa de cotizaciones en revisión manual usando la última foto', () => {
    const m = { ...demoAudit(now, 'UTC').metricas_diarias[0], en_revision_manual: 2 };
    expect(deriveAlerts(base({ servicios: [svc()], metricas_diarias: [m] }), now).map((a) => a.id)).toContain('revision-manual:global');
  });
});

describe('AuditPoller', () => {
  const config = { baseUrl: 'https://n8n.test', webhookPath: '/w', token: TOKEN, timezone: 'UTC', pollIntervalMs: 60_000, requestTimeoutMs: 1000, rangeDays: 30, port: 3000, demo: false };
  const ok = { servicios: [{ workflow_id: 'w1', workflow_nombre: 'AUD01', activo: true }], metricas_diarias: [] };

  it('sin configuración queda disabled y no consulta', async () => {
    const p = new AuditPoller(null);
    await p.refresh();
    expect(p.snapshot().status).toBe('disabled');
    await expect(p.query({})).rejects.toThrow(AuditFetchError);
  });
  it('ok -> stale (conserva datos) cuando n8n falla después', async () => {
    let fail = false;
    const f = (async () => (fail ? json({}, 500) : json(ok))) as unknown as typeof fetch;
    const p = new AuditPoller(config, { fetchImpl: f, now: () => Date.parse('2026-11-04T12:00:00Z') });
    await p.refresh();
    expect(p.snapshot().status).toBe('ok');
    fail = true;
    await p.refresh();
    expect(p.snapshot()).toMatchObject({ status: 'stale', error: 'n8n respondió 500' });
    expect(p.snapshot().data?.servicios).toHaveLength(1);
  });
  it('sin datos previos el fallo es error, y se recupera solo', async () => {
    let fail = true;
    const f = (async () => (fail ? json({}, 401) : json(ok))) as unknown as typeof fetch;
    const p = new AuditPoller(config, { fetchImpl: f });
    await p.refresh();
    expect(p.snapshot().status).toBe('error');
    expect(p.snapshot().data).toBeUndefined();
    expect(JSON.stringify(p.snapshot())).not.toContain(TOKEN);
    fail = false;
    await p.refresh();
    expect(p.snapshot().status).toBe('ok');
  });
  it('consultas simultáneas comparten una sola petición', async () => {
    let calls = 0;
    const f = (async () => (calls++, json(ok))) as unknown as typeof fetch;
    const p = new AuditPoller(config, { fetchImpl: f });
    await Promise.all([p.refresh(), p.refresh(), p.refresh()]);
    expect(calls).toBe(1);
  });
  it('la consulta puntual no pisa el snapshot del sondeo', async () => {
    const f = (async () => json(ok)) as unknown as typeof fetch;
    const p = new AuditPoller(config, { fetchImpl: f });
    const r = await p.query({ desde: '2026-01-01', hasta: '2026-01-31' });
    expect(r).toMatchObject({ status: 'ok', desde: '2026-01-01', hasta: '2026-01-31' });
    expect(p.snapshot().status).toBe('pending');
  });
  it('avisa a los suscriptores en cada sondeo', async () => {
    const f = (async () => json(ok)) as unknown as typeof fetch;
    const p = new AuditPoller(config, { fetchImpl: f });
    let n = 0;
    p.onChange(() => n++);
    await p.refresh();
    expect(n).toBe(1);
  });
});

describe('demoAudit', () => {
  it('es determinístico y tiene la forma de AUD04', () => {
    const a = demoAudit(Date.parse('2026-11-04T12:00:00Z'), 'UTC');
    expect(JSON.stringify(a)).toBe(JSON.stringify(demoAudit(Date.parse('2026-11-04T12:00:00Z'), 'UTC')));
    expect(normalizeAudit(JSON.parse(JSON.stringify(a))).servicios).toHaveLength(a.servicios.length);
  });
});

describe('cotizaciones en revisión manual', () => {
  const rev = (id: string, over = {}) => ({ cotizacion_id: id, numero_cotizacion: id.replace('COT-', ''), cliente: `Cliente ${id}`, comercial: 'Julián', valor: '1000', estado_actual: 'REVISION_MANUAL', requiere_revision: true, ...over });

  it('si AUD04 no trae el campo queda ausente (no se confunde con "ninguna")', () => {
    expect(normalizeAudit({ servicios: [] }).cartera_diaria).toBeUndefined();
    const c = normalizeAudit({
      servicios: [],
      cartera_diaria: [{ fecha: '2026-11-11T00:00:00Z', cartera_abierta: '1000', pct_vencida: 'x' }, { fecha: '2026-11-10', cartera_abierta: 900 }, { cartera_abierta: 5 }],
      cartera_morosos: { fecha: '2026-11-11', cartera_al: null, clientes: [{ nit: '1', cliente: 'A', saldo_moroso: 5 }, { nit: '2', cliente: 'B', saldo_moroso: '50' }, {}] },
    });
    expect(c.cartera_diaria?.map((r) => r.fecha)).toEqual(['2026-11-10', '2026-11-11']);
    expect(c.cartera_diaria?.[1]).toMatchObject({ cartera_abierta: 1000, pct_vencida: 0 });
    expect(c.cartera_morosos?.clientes.map((m) => m.cliente)).toEqual(['B', 'A']);
    expect(normalizeAudit({ servicios: [] }).cotizaciones_revision).toBeUndefined();
    expect(normalizeAudit({ servicios: [], cotizaciones_revision: [] }).cotizaciones_revision).toEqual([]);
  });
  it('normaliza valores y deduplica por cotizacion_id', () => {
    const d = normalizeAudit({ servicios: [], cotizaciones_revision: [rev('COT-1'), rev('COT-1'), rev('COT-2', { valor: 'x', numero_cotizacion: '' }), { cliente: 'sin id' }] });
    expect(d.cotizaciones_revision?.map((q) => q.cotizacion_id)).toEqual(['COT-1', 'COT-2']);
    expect(d.cotizaciones_revision?.[0]).toMatchObject({ valor: 1000, requiere_revision: true });
    expect(d.cotizaciones_revision?.[1]).toMatchObject({ valor: 0, numero_cotizacion: undefined });
  });
  it('la alerta nombra las primeras 3 y resume el resto', () => {
    const list = ['COT-1', 'COT-2', 'COT-3', 'COT-4', 'COT-5'].map((id) => rev(id));
    const data = base({ servicios: [{ workflow_id: 'a', workflow_nombre: 'A', activo: true, errores_24h: 0, actualizado_en: new Date().toISOString() }], cotizaciones_revision: normalizeAudit({ servicios: [], cotizaciones_revision: list }).cotizaciones_revision });
    const a = deriveAlerts(data, Date.now()).find((x) => x.id === 'revision-manual:global');
    expect(a?.text).toBe('5 cotización(es) en revisión manual: Cliente COT-1 (1), Cliente COT-2 (2), Cliente COT-3 (3) y 2 más');
  });
  it('sin número de cotización nombra solo al cliente; sin cliente, lo dice', () => {
    const data = base({ cotizaciones_revision: [{ cotizacion_id: 'REV-1', cliente: 'CONSORCIO SKF', valor: 0, requiere_revision: true }, { cotizacion_id: 'REV-2', valor: 0, requiere_revision: true }] });
    expect(deriveAlerts(data, Date.now()).find((x) => x.id === 'revision-manual:global')?.text).toContain('CONSORCIO SKF, cliente sin nombre');
  });
  it('la lista manda sobre el conteo de AUD01; sin lista usa el conteo', () => {
    const m = { ...demoAudit(Date.now(), 'UTC').metricas_diarias[0], en_revision_manual: 5 };
    expect(deriveAlerts(base({ metricas_diarias: [m], cotizaciones_revision: [] }), Date.now()).some((x) => x.id === 'revision-manual:global')).toBe(false);
    expect(deriveAlerts(base({ metricas_diarias: [m] }), Date.now()).find((x) => x.id === 'revision-manual:global')?.text).toBe('5 cotización(es) en revisión manual');
  });
});
