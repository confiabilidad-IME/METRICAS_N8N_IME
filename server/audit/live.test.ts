import { describe, expect, it } from 'vitest';
import { AuditFetchError } from './client';
import { fetchLive, mergeLive } from './live';
import { AuditPoller } from './poller';

const KEY = 'api-key-secreta';
const NOW = Date.parse('2026-11-04T17:00:00Z');
const cfg = { baseUrl: 'https://n8n.test', apiKey: KEY, timezone: 'America/Bogota', requestTimeoutMs: 1000 };
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const WFS = [
  { id: 'a', name: 'Flujo A', active: true },
  { id: 'b', name: 'Flujo B', active: true },
  { id: 'c', name: 'Flujo C', active: false },
  { id: 'z', name: 'Archivado', active: true, isArchived: true },
];
const EXECS = [
  { workflowId: 'a', status: 'success', startedAt: ago(5), stoppedAt: ago(5 - 0.05) },
  { workflowId: 'a', status: 'error', startedAt: ago(60), stoppedAt: ago(59.9) },
  { workflowId: 'a', status: 'crashed', startedAt: ago(26 * 60), stoppedAt: ago(26 * 60 - 1) },
  { workflowId: 'huerfano', status: 'success', startedAt: ago(1) },
];

/** n8n falso: enruta por ruta, anota los headers y soporta paginación por cursor. */
function fakeN8n(opts: { lookup?: Record<string, unknown>; fail?: number } = {}) {
  const calls: string[] = [];
  const headers: Headers[] = [];
  const f = (async (u: URL, init?: RequestInit) => {
    calls.push(u.pathname + u.search);
    headers.push(new Headers(init?.headers));
    if (opts.fail) return new Response('{}', { status: opts.fail });
    const q = u.searchParams;
    if (u.pathname === '/api/v1/workflows') return new Response(JSON.stringify({ data: WFS, nextCursor: null }));
    if (u.pathname === '/api/v1/executions') {
      if (q.get('workflowId')) return new Response(JSON.stringify({ data: opts.lookup?.[q.get('workflowId')!] ? [opts.lookup[q.get('workflowId')!]] : [], nextCursor: null }));
      return q.get('cursor') ? new Response(JSON.stringify({ data: [], nextCursor: null })) : new Response(JSON.stringify({ data: EXECS, nextCursor: 'p2' }));
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls, headers };
}

describe('fetchLive', () => {
  it('usa la llave por header X-N8N-API-KEY y nunca en la URL', async () => {
    const n = fakeN8n();
    await fetchLive(cfg, NOW, n.f);
    expect(n.headers.every((h) => h.get('x-n8n-api-key') === KEY)).toBe(true);
    expect(n.calls.join(' ')).not.toContain(KEY);
  });

  it('arma un servicio por workflow (sin archivados) con estado de la última ejecución y errores de 24 h', async () => {
    const { servicios } = await fetchLive(cfg, NOW, fakeN8n().f);
    expect(servicios.map((s) => s.workflow_id)).toEqual(['a', 'b', 'c']);
    const a = servicios[0];
    expect(a).toMatchObject({ activo: true, estado_ultima: 'success', errores_24h: 1 });
    // la ejecución caída de hace 26 h no cuenta como error de 24 h
    expect(a.ultima_ejecucion).toBe(ago(5));
    expect(servicios[2].activo).toBe(false);
  });

  it('ignora ejecuciones de workflows que no están en el proyecto', async () => {
    const { ejecucionesHoy } = await fetchLive(cfg, NOW, fakeN8n().f);
    expect(ejecucionesHoy.map((e) => e.workflow_id)).toEqual(['a']);
  });

  it('cuenta las ejecuciones de hoy en la zona horaria configurada', async () => {
    // 17:00 UTC = 12:00 en Bogotá; "hoy" = 2026-11-04. La de hace 26 h cae en el día anterior y no entra.
    const { ejecucionesHoy } = await fetchLive(cfg, NOW, fakeN8n().f);
    expect(ejecucionesHoy[0]).toMatchObject({ fecha: '2026-11-04', total: 2, exitosas: 1, errores: 1 });
    expect(ejecucionesHoy[0].duracion_prom_seg).toBeGreaterThan(0);
  });

  it('un flujo activo sin ejecuciones recientes consulta su última ejecución aparte y la cachea', async () => {
    const old = { workflowId: 'b', status: 'success', startedAt: '2026-10-28T14:00:00Z' };
    const n = fakeN8n({ lookup: { b: old } });
    const cache = new Map();
    const first = await fetchLive(cfg, NOW, n.f, cache);
    expect(first.servicios[1]).toMatchObject({ ultima_ejecucion: old.startedAt, estado_ultima: 'success' });
    const before = n.calls.filter((c) => c.includes('workflowId=b')).length;
    await fetchLive(cfg, NOW + 60_000, n.f, cache);
    expect(n.calls.filter((c) => c.includes('workflowId=b')).length).toBe(before);
  });

  it('un flujo activo que nunca se ejecutó queda sin última ejecución (no inventa)', async () => {
    const { servicios } = await fetchLive(cfg, NOW, fakeN8n().f);
    expect(servicios[1].ultima_ejecucion).toBeUndefined();
  });

  it.each([401, 403])('HTTP %i -> llave rechazada, sin exponerla', async (status) => {
    const err = await fetchLive(cfg, NOW, fakeN8n({ fail: status }).f).catch((e: AuditFetchError) => e);
    expect(err).toBeInstanceOf(AuditFetchError);
    expect((err as Error).message).toMatch(/N8N_API_KEY/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('con projectId lo manda; si la instancia no lo acepta (400) reintenta sin él', async () => {
    const calls: string[] = [];
    const f = (async (u: URL) => {
      calls.push(u.search);
      if (u.pathname === '/api/v1/workflows' && u.searchParams.has('projectId')) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ data: u.pathname.endsWith('workflows') ? WFS : [], nextCursor: null }));
    }) as unknown as typeof fetch;
    const r = await fetchLive({ ...cfg, projectId: 'P1' }, NOW, f);
    expect(calls[0]).toContain('projectId=P1');
    expect(r.servicios).toHaveLength(3);
  });
});

describe('mergeLive', () => {
  it('reemplaza servicios y las filas de hoy; conserva los días anteriores de AUD03', () => {
    const row = (fecha: string, total: number) => ({ workflow_id: 'a', workflow_nombre: 'A', fecha, total, exitosas: total, errores: 0, duracion_prom_seg: 1 });
    const merged = mergeLive(
      { servicios: [], ejecuciones_diarias: [row('2026-11-03', 9), row('2026-11-04', 1)] },
      { servicios: [{ workflow_id: 'a', workflow_nombre: 'A', activo: true, errores_24h: 0 }], ejecucionesHoy: [row('2026-11-04', 7)] },
      '2026-11-04',
    );
    expect(merged.servicios).toHaveLength(1);
    expect(merged.ejecuciones_diarias.map((e) => [e.fecha, e.total])).toEqual([
      ['2026-11-03', 9],
      ['2026-11-04', 7],
    ]);
  });
});

describe('AuditPoller con API en vivo', () => {
  const base = { baseUrl: 'https://n8n.test', webhookPath: '/w', token: 'tok', apiKey: KEY, timezone: 'America/Bogota', pollIntervalMs: 60_000, requestTimeoutMs: 1000, rangeDays: 30, port: 3000, demo: false };
  const aud04 = { servicios: [], metricas_diarias: [], ejecuciones_diarias: [] };

  function router(apiStatus = 200) {
    const n8n = fakeN8n({ fail: apiStatus === 200 ? undefined : apiStatus });
    return (async (u: URL, init?: RequestInit) => (u.pathname === '/w' ? new Response(JSON.stringify(aud04)) : n8n.f(u, init))) as unknown as typeof fetch;
  }

  it('servicios en vivo cuando la API responde', async () => {
    const p = new AuditPoller(base, { fetchImpl: router(), now: () => NOW });
    await p.refresh();
    expect(p.snapshot()).toMatchObject({ status: 'ok', fuenteServicios: 'api' });
    expect(p.snapshot().data?.servicios).toHaveLength(3);
  });

  it('si la API falla, el tablero sigue con AUD03 y lo dice (sin la llave)', async () => {
    const p = new AuditPoller(base, { fetchImpl: router(401), now: () => NOW });
    await p.refresh();
    const s = p.snapshot();
    expect(s).toMatchObject({ status: 'ok', fuenteServicios: 'AUD03' });
    expect(s.errorApi).toMatch(/N8N_API_KEY/);
    expect(JSON.stringify(s)).not.toContain(KEY);
  });

  it('sin N8N_API_KEY usa AUD03 sin intentar la API', async () => {
    const seen: string[] = [];
    const f = (async (u: URL) => (seen.push(u.pathname), new Response(JSON.stringify(aud04)))) as unknown as typeof fetch;
    const p = new AuditPoller({ ...base, apiKey: undefined }, { fetchImpl: f, now: () => NOW });
    await p.refresh();
    expect(seen).toEqual(['/w']);
    expect(p.snapshot().fuenteServicios).toBe('AUD03');
  });
});

describe('detalle del error', () => {
  const failed = [{ id: '501', workflowId: 'a', status: 'error', startedAt: ago(20), stoppedAt: ago(19.9) }, { id: '500', workflowId: 'a', status: 'success', startedAt: ago(90), stoppedAt: ago(89) }];
  function n8n(detail: unknown, detailStatus = 200) {
    const calls: string[] = [];
    const f = (async (u: URL) => {
      calls.push(u.pathname + u.search);
      if (u.pathname === '/api/v1/workflows') return new Response(JSON.stringify({ data: [WFS[0]], nextCursor: null }));
      if (u.pathname === '/api/v1/executions/501') return new Response(JSON.stringify(detail), { status: detailStatus });
      if (u.pathname === '/api/v1/executions') return new Response(JSON.stringify({ data: failed, nextCursor: null }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const detail = { data: { resultData: { lastNodeExecuted: 'Otro', error: { message: 'Request failed with status code 404', node: { name: 'Listar workflows' } } } } };

  it('lee nodo y mensaje de la ejecución fallida más reciente', async () => {
    const { servicios } = await fetchLive(cfg, NOW, n8n(detail).f);
    expect(servicios[0].ultimo_error).toEqual({ execution_id: '501', at: ago(20), nodo: 'Listar workflows', mensaje: 'Request failed with status code 404' });
  });
  it('no pide el detalle de una ejecución que ya conoce', async () => {
    const n = n8n(detail);
    const errCache = new Map();
    await fetchLive(cfg, NOW, n.f, new Map(), errCache);
    await fetchLive(cfg, NOW + 60_000, n.f, new Map(), errCache);
    expect(n.calls.filter((c) => c.includes('/executions/501')).length).toBe(1);
  });
  it('usa el nodo de lastNodeExecuted si el error no trae nodo, y recorta mensajes largos', async () => {
    const d = { data: { resultData: { lastNodeExecuted: 'Nodo X', error: { message: 'x'.repeat(1000) } } } };
    const { servicios } = await fetchLive(cfg, NOW, n8n(d).f);
    expect(servicios[0].ultimo_error?.nodo).toBe('Nodo X');
    expect(servicios[0].ultimo_error?.mensaje).toHaveLength(300);
  });
  it('si el detalle no se puede leer, igual informa qué ejecución falló (sin nodo ni mensaje)', async () => {
    const { servicios } = await fetchLive(cfg, NOW, n8n({}, 500).f);
    expect(servicios[0].ultimo_error).toMatchObject({ execution_id: '501', at: ago(20) });
    expect(servicios[0].ultimo_error?.nodo).toBeUndefined();
  });
});
