import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditAlert } from '../../../shared/audit';
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import { setAccess } from './access';
import { diffFeed, diffNotices, POLL_MS } from './poll';
import { OfficeStore, reconnectDelay } from './store';

const T = 1_700_000_000_000;

const agent = (id: string, actId: string | undefined, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  kind: 'main',
  roomId: 'n8n',
  name: id.toUpperCase(),
  look: 'f',
  role: 'Flujo n8n',
  title: `Flujo ${id}`,
  sessionId: id,
  account: 'n8n',
  status: 'idle',
  activity: actId ? { id: actId, kind: 'run', icon: '⚙️', text: 'Ejecución completada', at: T } : undefined,
  recent: [],
  tasks: [],
  startedAt: T,
  lastEventAt: T,
  statusSince: T,
  stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
  seed: 1,
  ...over,
});

const alert = (id: string): AuditAlert => ({ id, level: 'warn', text: `alerta ${id}`, since: T });

const snap = (agents: AgentInfo[], alertas: AuditAlert[] | null = null, rev = 1): OfficeSnapshot => ({
  rev,
  serverTime: T,
  rooms: [{ id: 'n8n', name: 'n8n', path: 'x', slot: 0, seed: 1, createdAt: T }],
  agents,
  accounts: [],
  ...(alertas ? { audit: { status: 'ok' as const, desde: '2026-10-05', alertas, data: { generado_en: '', rango: { desde: null, hasta: null }, metricas_diarias: [], ejecuciones_diarias: [], servicios: [], cotizaciones_definidas: [] } } } : {}),
  meta: { demo: false, sources: [], startedAt: T, version: 't' },
});

describe('diffFeed', () => {
  it('la primera carga no genera feed', () => {
    expect(diffFeed(null, snap([agent('a', 'x1')]))).toEqual([]);
  });
  it('un agente cuya actividad cambió entra al feed, con el nombre de la sala', () => {
    const items = diffFeed(snap([agent('a', 'x1')]), snap([agent('a', 'x2')]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'x2', agentId: 'a', agentName: 'A', roomName: 'n8n' });
  });
  it('sin cambios, un agente nuevo, o la actividad "sin ejecuciones" no generan feed', () => {
    expect(diffFeed(snap([agent('a', 'x1')]), snap([agent('a', 'x1')]))).toEqual([]);
    expect(diffFeed(snap([]), snap([agent('nuevo', 'x1')]))).toEqual([]);
    const wait = agent('a', 'x2');
    wait.activity!.kind = 'wait';
    expect(diffFeed(snap([agent('a', 'x1')]), snap([wait]))).toEqual([]);
  });
  it('AUD04 (la consulta del propio tablero) no hace ruido', () => {
    const aud04 = (id: string) => agent('b', id, { title: 'AUD04 - API de metricas' });
    expect(diffFeed(snap([aud04('x1')]), snap([aud04('x2')]))).toEqual([]);
  });
});

describe('diffNotices', () => {
  it('solo avisa de alertas nuevas, y solo con una auditoría previa', () => {
    const prev = snap([], [alert('a')]);
    const next = snap([], [alert('a'), alert('b')]);
    expect(diffNotices(prev, next, T).map((n) => n.id)).toEqual([`b@${T}`]);
    expect(diffNotices(snap([]), next, T)).toEqual([]);
    expect(diffNotices(null, next, T)).toEqual([]);
  });
  it('si una alerta desaparece y vuelve, vuelve a avisar', () => {
    expect(diffNotices(snap([], []), snap([], [alert('a')]), T)).toHaveLength(1);
  });
});

describe('OfficeStore en modo consulta periódica', () => {
  const originalFetch = globalThis.fetch;
  const assign = vi.fn();
  let responses: Array<() => Response | Promise<Response>>;
  let calls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    responses = [];
    assign.mockReset();
    setAccess({ remote: false, local: true, permissions: false, messages: false, terminal: false, spawn: false, polling: true });
    globalThis.fetch = (async (u: string) => {
      calls.push(String(u));
      const next = responses.shift();
      if (!next) throw new Error('sin respuesta preparada');
      return next();
    }) as unknown as typeof fetch;
    vi.stubGlobal('location', { assign, search: '' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    setAccess(null);
  });

  const ok = (s: OfficeSnapshot) => () => new Response(JSON.stringify(s), { status: 200 });

  it('consulta /api/snapshot (no abre SSE), publica el snapshot y repite cada POLL_MS', async () => {
    const store = new OfficeStore({ eventSource: () => { throw new Error('no debería abrir SSE'); } });
    const seen: number[] = [];
    store.on('snapshot', (s) => seen.push(s.rev));
    responses = [ok(snap([agent('a', 'x1')], null, 1)), ok(snap([agent('a', 'x2')], null, 2))];
    store.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['/api/snapshot']);
    expect(store.connection).toBe('open');
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([1, 2]);
    store.disconnect();
  });

  it('deduce el feed entre consultas', async () => {
    const store = new OfficeStore({});
    const feed: string[] = [];
    store.on('feed', (items) => feed.push(...items.map((i) => i.id)));
    responses = [ok(snap([agent('a', 'x1')], null, 1)), ok(snap([agent('a', 'x2')], null, 2))];
    store.connect();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(feed).toEqual(['x2']);
    store.disconnect();
  });

  it('sesión vencida (401): va a /login y no sigue consultando', async () => {
    const store = new OfficeStore({});
    responses = [() => new Response('{}', { status: 401 })];
    store.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(assign).toHaveBeenCalledWith('/login');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(calls).toHaveLength(1);
    store.disconnect();
  });

  it('si falla: queda "closed", informa la próxima tentativa y reintenta con espera creciente; al volver, "open"', async () => {
    const store = new OfficeStore({});
    const states: string[] = [];
    store.on('connection', (c) => states.push(c));
    responses = [() => new Response('{}', { status: 502 }), () => new Response('{}', { status: 502 }), ok(snap([], null, 1))];
    store.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.connection).toBe('closed');
    expect(store.nextRetryAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(reconnectDelay(0));
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(reconnectDelay(1));
    expect(calls).toHaveLength(3);
    expect(store.connection).toBe('open');
    expect(store.nextRetryAt).toBeNull();
    // 'connecting' es el estado inicial: no cuenta como cambio.
    expect(states).toEqual(['closed', 'open']);
    store.disconnect();
  });

  it('"Tentar agora" (reconnectNow) consulta sin esperar, y no duplica consultas en curso', async () => {
    const store = new OfficeStore({});
    let release!: (r: Response) => void;
    responses = [() => new Promise<Response>((r) => (release = r)), ok(snap([], null, 1))];
    store.connect();
    await vi.advanceTimersByTimeAsync(0);
    store.reconnectNow(); // hay una en vuelo: no lanza otra
    expect(calls).toHaveLength(1);
    release(new Response(JSON.stringify(snap([], null, 1)), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.connection).toBe('open');
    store.disconnect();
  });

  it('disconnect() detiene el sondeo', async () => {
    const store = new OfficeStore({});
    responses = [ok(snap([], null, 1)), ok(snap([], null, 2))];
    store.connect();
    await vi.advanceTimersByTimeAsync(0);
    store.disconnect();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(calls).toHaveLength(1);
  });

  it('sin `polling` en el acceso sigue usando SSE', async () => {
    setAccess({ remote: false, local: true, permissions: false, messages: false, terminal: false, spawn: false });
    let opened = '';
    const store = new OfficeStore({ eventSource: (url) => ({ readyState: 0, addEventListener() {}, close() {}, ...(opened = url, {}) }) });
    store.connect();
    expect(opened).toBe('/api/stream');
    expect(calls).toEqual([]);
    store.disconnect();
  });
});
