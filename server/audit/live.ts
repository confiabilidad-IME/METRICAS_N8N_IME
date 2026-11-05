// Estado de servicios y ejecuciones EN VIVO desde la API pública de n8n (GET /api/v1/workflows y /api/v1/executions,
// header X-N8N-API-KEY). Es la fuente primaria de "servicios" y de las ejecuciones de hoy; AUD04 sigue siendo la de las
// métricas de negocio y del historial de días anteriores (lo consolida AUD03). Solo lectura.
import type { AuditExecutionDay, AuditLastError, AuditService } from '../../shared/audit';
import { AuditFetchError } from './client';
import { dayIn } from './derive';

export interface LiveConfig {
  baseUrl: string;
  apiKey: string;
  /** Si se define, solo los workflows de ese proyecto (parámetro projectId de la API). */
  projectId?: string;
  timezone: string;
  requestTimeoutMs: number;
}

export interface LiveData {
  servicios: AuditService[];
  /** Ejecuciones de HOY por flujo (en APP_TIMEZONE). */
  ejecucionesHoy: AuditExecutionDay[];
}

/** Última ejecución conocida de un flujo que no aparece en las páginas recientes; se vuelve a pedir cada 10 min. */
export type LastSeenCache = Map<string, { at: number; exec: Exec | null }>;

interface Exec {
  id?: string | number;
  workflowId: string;
  status?: string;
  startedAt?: string;
  stoppedAt?: string | null;
}
interface Wf {
  id: string;
  name: string;
  active: boolean;
  isArchived?: boolean;
}

const PAGE = 250;
const MAX_PAGES = 5;
const HOUR = 3600_000;
const FAILED = new Set(['error', 'crashed']);
const LAST_SEEN_TTL = 10 * 60_000;
const MAX_LOOKUPS = 40;
const MAX_ERROR_LOOKUPS = 8;
const MESSAGE_MAX = 300;

/** Detalle de error ya leído por ejecución (las ejecuciones no cambian: no se vuelve a pedir). */
export type ErrorCache = Map<string, { nodo?: string; mensaje?: string }>;

async function getJson(cfg: LiveConfig, path: string, params: Record<string, string>, f: typeof fetch): Promise<{ data?: unknown; nextCursor?: string | null }> {
  const url = new URL(cfg.baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await f(url, { headers: { 'X-N8N-API-KEY': cfg.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(cfg.requestTimeoutMs), redirect: 'error' });
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new AuditFetchError(name === 'TimeoutError' || name === 'AbortError' ? 'la API de n8n no respondió a tiempo' : 'no se pudo conectar con la API de n8n');
  }
  if (res.status === 401 || res.status === 403) throw new AuditFetchError('N8N_API_KEY rechazada por la API de n8n', res.status);
  if (!res.ok) throw new AuditFetchError(`la API de n8n respondió ${res.status}`, res.status);
  try {
    return (await res.json()) as { data?: unknown; nextCursor?: string | null };
  } catch {
    throw new AuditFetchError('la API de n8n no devolvió JSON');
  }
}

async function paged<T>(cfg: LiveConfig, path: string, params: Record<string, string>, f: typeof fetch, stop?: (batch: T[]) => boolean): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await getJson(cfg, path, { ...params, limit: String(PAGE), ...(cursor ? { cursor } : {}) }, f);
    const batch = Array.isArray(body.data) ? (body.data as T[]) : [];
    out.push(...batch);
    cursor = body.nextCursor ?? undefined;
    if (!cursor || !batch.length || stop?.(batch)) break;
  }
  return out;
}

const ms = (iso: string | null | undefined): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : NaN;
};

async function listWorkflows(cfg: LiveConfig, f: typeof fetch): Promise<Wf[]> {
  let rows: Wf[];
  try {
    rows = await paged<Wf>(cfg, '/api/v1/workflows', cfg.projectId ? { projectId: cfg.projectId } : {}, f);
  } catch (e) {
    // Instancias que no aceptan el filtro de proyecto: se reintenta sin él (una llave mala no se reintenta).
    if (cfg.projectId && e instanceof AuditFetchError && (e.status === 400 || e.status === 404)) rows = await paged<Wf>(cfg, '/api/v1/workflows', {}, f);
    else throw e;
  }
  return rows.filter((w) => w && typeof w.id === 'string' && !w.isArchived);
}

/** Nodo y mensaje de una ejecución fallida (GET /executions/:id?includeData=true). Si falla la consulta, devuelve vacío. */
async function errorDetail(cfg: LiveConfig, id: string, f: typeof fetch): Promise<{ nodo?: string; mensaje?: string }> {
  try {
    const body = (await getJson(cfg, `/api/v1/executions/${encodeURIComponent(id)}`, { includeData: 'true' }, f)) as { data?: { resultData?: { error?: { message?: unknown; description?: unknown; node?: { name?: unknown } }; lastNodeExecuted?: unknown } } };
    const rd = body.data?.resultData;
    const text = [rd?.error?.message, rd?.error?.description].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    const node = rd?.error?.node?.name ?? rd?.lastNodeExecuted;
    return { nodo: typeof node === 'string' ? node : undefined, mensaje: text ? text.trim().slice(0, MESSAGE_MAX) : undefined };
  } catch {
    return {};
  }
}

export async function fetchLive(cfg: LiveConfig, now: number, f: typeof fetch = fetch, cache: LastSeenCache = new Map(), errCache: ErrorCache = new Map()): Promise<LiveData> {
  const workflows = await listWorkflows(cfg, f);
  const ids = new Set(workflows.map((w) => w.id));
  const since = now - 36 * HOUR;
  const execs = (await paged<Exec>(cfg, '/api/v1/executions', {}, f, (b) => b.every((e) => ms(e.startedAt) < since))).filter((e) => e && ids.has(e.workflowId) && Number.isFinite(ms(e.startedAt)));

  const latest = new Map<string, Exec>();
  for (const e of execs) {
    const cur = latest.get(e.workflowId);
    if (!cur || ms(e.startedAt) > ms(cur.startedAt)) latest.set(e.workflowId, e);
  }

  // Flujos activos sin ejecución reciente en las páginas: su última ejecución se consulta aparte (con caché).
  let lookups = 0;
  for (const w of workflows) {
    if (!w.active || latest.has(w.id)) continue;
    let hit = cache.get(w.id);
    if (!hit || now - hit.at > LAST_SEEN_TTL) {
      if (lookups++ >= MAX_LOOKUPS) continue;
      const body = await getJson(cfg, '/api/v1/executions', { workflowId: w.id, limit: '1' }, f);
      const first = Array.isArray(body.data) ? (body.data[0] as Exec | undefined) : undefined;
      hit = { at: now, exec: first && Number.isFinite(ms(first.startedAt)) ? first : null };
      cache.set(w.id, hit);
    }
    if (hit.exec) latest.set(w.id, hit.exec);
  }

  const stamp = new Date(now).toISOString();
  const last24 = now - 24 * HOUR;
  const servicios: AuditService[] = workflows.map((w) => {
    const l = latest.get(w.id);
    return {
      workflow_id: w.id,
      workflow_nombre: w.name,
      activo: w.active === true,
      ultima_ejecucion: l?.startedAt,
      estado_ultima: l?.status,
      errores_24h: execs.filter((e) => e.workflowId === w.id && FAILED.has(e.status ?? '') && ms(e.startedAt) >= last24).length,
      actualizado_en: stamp,
    };
  });

  // Ejecución fallida más reciente de cada flujo activo con error (la última, o la de las últimas 24 h).
  let errLookups = 0;
  for (const s of servicios) {
    if (!s.activo || !(s.errores_24h > 0 || FAILED.has(s.estado_ultima ?? ''))) continue;
    const failed = execs.filter((e) => e.workflowId === s.workflow_id && FAILED.has(e.status ?? '') && e.id !== undefined).sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
    if (!failed || failed.id === undefined) continue;
    const id = String(failed.id);
    let d = errCache.get(id);
    if (!d && errLookups++ < MAX_ERROR_LOOKUPS) {
      d = await errorDetail(cfg, id, f);
      errCache.set(id, d);
    }
    const ultimo_error: AuditLastError = { execution_id: id, at: failed.startedAt ?? stamp, ...d };
    s.ultimo_error = ultimo_error;
  }

  const today = dayIn(cfg.timezone, now);
  const names = new Map(workflows.map((w) => [w.id, w.name]));
  const byFlow = new Map<string, { total: number; ok: number; err: number; dur: number; durN: number; last: string }>();
  for (const e of execs) {
    if (dayIn(cfg.timezone, ms(e.startedAt)) !== today) continue;
    const a = byFlow.get(e.workflowId) ?? { total: 0, ok: 0, err: 0, dur: 0, durN: 0, last: '' };
    a.total++;
    if (e.status === 'success') a.ok++;
    if (FAILED.has(e.status ?? '')) a.err++;
    const d = ms(e.stoppedAt) - ms(e.startedAt);
    if (Number.isFinite(d) && d >= 0) {
      a.dur += d;
      a.durN++;
    }
    if (!a.last || (e.startedAt ?? '') > a.last) a.last = e.startedAt ?? '';
    byFlow.set(e.workflowId, a);
  }
  const ejecucionesHoy: AuditExecutionDay[] = [...byFlow].map(([id, a]) => ({
    workflow_id: id,
    workflow_nombre: names.get(id) ?? id,
    fecha: today,
    total: a.total,
    exitosas: a.ok,
    errores: a.err,
    duracion_prom_seg: a.durN ? Math.round((a.dur / a.durN / 1000) * 10) / 10 : 0,
    ultima_ejecucion: a.last || undefined,
  }));
  return { servicios, ejecucionesHoy };
}

/** Reemplaza los servicios por los de la API y las filas de hoy por las en vivo; los días anteriores quedan como los dejó AUD03. */
export function mergeLive<T extends { servicios: AuditService[]; ejecuciones_diarias: AuditExecutionDay[] }>(data: T, live: LiveData, today: string): T {
  return { ...data, servicios: live.servicios, ejecuciones_diarias: [...data.ejecuciones_diarias.filter((e) => e.fecha !== today), ...live.ejecucionesHoy] };
}
