// Modelo del panel de auditoría: formatos, orden y agregaciones. Puro (sin DOM) y probado en audit-model.test.ts.
// Los textos están en español: son datos del negocio de IME (n8n), no del diccionario de Habblaud.
import type { AuditExecutionDay, AuditQuote, AuditReviewQuote, AuditService, AuditSnapshot, AuditStatus } from '../../../shared/audit';

const compact = new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/** "$ 84,8 M" (tarjetas). */
export function moneyShort(n: number): string {
  return `$ ${compact.format(n)}`;
}

/** "$ 84.767.579" (detalle en tablas y títulos). */
export function moneyFull(n: number): string {
  return full.format(n).replace(/\s/g, ' ');
}

export function count(n: number): string {
  return int.format(n);
}

/** 0.9091 -> "90,9 %"; null -> "—". */
export function percent(r: number | null): string {
  return r === null ? '—' : `${(r * 100).toFixed(1).replace('.', ',')} %`;
}

/** "hace 5 min" / "hace 3 h" / "hace 2 d"; vacío o fecha inválida -> "nunca". */
export function ago(iso: string | undefined, now: number): string {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return 'nunca';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'hace instantes';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86_400)} d`;
}

/** "3 nov" a partir de YYYY-MM-DD (sin pasar por Date local: evita correrse un día). */
export function dayShort(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${Number(m[2])} ${months[Number(m[1]) - 1] ?? m[1]}`;
}

export const STATUS_LABEL: Record<AuditStatus, string> = {
  disabled: 'Sin configurar',
  pending: 'Conectando…',
  ok: 'Al día',
  stale: 'Datos desactualizados',
  error: 'Sin conexión con n8n',
};

/** Texto de ayuda bajo el estado (qué hacer). */
export function statusHint(a: AuditSnapshot | undefined): string {
  if (!a) return 'Esperando datos del servidor…';
  switch (a.status) {
    case 'disabled':
      return 'Faltan N8N_BASE_URL y/o N8N_AUDIT_TOKEN en el .env del servidor.';
    case 'pending':
      return 'Consultando AUD04…';
    case 'stale':
    case 'error':
      return a.error ?? 'No se pudo consultar n8n.';
    default:
      return '';
  }
}

export type ServiceState = 'error' | 'warn' | 'ok' | 'inactive';

export interface ServiceRow {
  id: string;
  name: string;
  state: ServiceState;
  label: string;
  last: string;
  errors24h: number;
}

const FAILED = new Set(['error', 'crashed']);

/** Errores primero, luego con advertencias, luego sanos; los inactivos al final; desempate por nombre. */
export function serviceRows(services: readonly AuditService[], now: number): ServiceRow[] {
  const rank: Record<ServiceState, number> = { error: 0, warn: 1, ok: 2, inactive: 3 };
  const rows = services.map((s): ServiceRow => {
    const failed = FAILED.has((s.estado_ultima ?? '').toLowerCase());
    const state: ServiceState = !s.activo ? 'inactive' : failed ? 'error' : s.errores_24h > 0 ? 'warn' : 'ok';
    const label = { error: 'Falló', warn: `${s.errores_24h} error(es)`, ok: 'Activo', inactive: 'Inactivo' }[state];
    return { id: s.workflow_id, name: s.workflow_nombre, state, label, last: ago(s.ultima_ejecucion, now), errors24h: s.errores_24h };
  });
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name, 'es'));
}

export interface ExecColumn {
  day: string;
  total: number;
  errors: number;
  ok: number;
}

/** Ejecuciones por día sumando todos los flujos, de la fecha más antigua a la más reciente. */
export function execColumns(rows: readonly AuditExecutionDay[]): ExecColumn[] {
  const by = new Map<string, ExecColumn>();
  for (const r of rows) {
    const c = by.get(r.fecha) ?? { day: r.fecha, total: 0, errors: 0, ok: 0 };
    c.total += r.total;
    c.errors += r.errores;
    c.ok += r.exitosas;
    by.set(r.fecha, c);
  }
  return [...by.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export interface QuoteRow {
  id: string;
  number: string;
  client: string;
  owner: string;
  won: boolean;
  value: number;
  day: string;
  detail: string;
}

/** Cotizaciones definidas, las más recientes primero. */
export function quoteRows(quotes: readonly AuditQuote[], limit = 15): QuoteRow[] {
  return [...quotes]
    .sort((a, b) => (b.fecha_definicion ?? '').localeCompare(a.fecha_definicion ?? ''))
    .slice(0, limit)
    .map((q) => ({
      id: q.cotizacion_id,
      number: q.numero_cotizacion ?? q.cotizacion_id,
      client: q.cliente ?? '—',
      owner: q.comercial ?? '—',
      won: q.resultado_final === 'GANADA',
      value: q.valor,
      day: (q.fecha_definicion ?? '').slice(0, 10),
      detail: q.resultado_final === 'GANADA' ? (q.numero_oc ? `OC ${q.numero_oc}` : '') : (q.motivo_perdida ?? ''),
    }));
}

export interface RangeOption {
  id: string;
  label: string;
  /** Días hacia atrás; null = el rango del servidor (en vivo por SSE). */
  days: number | null;
}

export const RANGES: readonly RangeOption[] = [
  { id: '30', label: 'Últimos 30 días', days: null },
  { id: '7', label: 'Últimos 7 días', days: 7 },
  { id: '90', label: 'Últimos 90 días', days: 90 },
];

/** URL de la consulta puntual para un rango; `today` = YYYY-MM-DD de hoy. */
export function auditUrl(days: number | null, today: string): string {
  if (days === null) return '/api/audit';
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return `/api/audit?desde=${d.toISOString().slice(0, 10)}`;
}

/** Altura (0–100) de una barra respecto al máximo de la serie, con un mínimo visible para valores > 0. */
export function barHeight(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(4, Math.round((value / max) * 100));
}

export interface ErrorRow {
  id: string;
  name: string;
  /** "falló hace 20 min" o "1 error(es) en 24 h" cuando no hay detalle de la ejecución. */
  when: string;
  node?: string;
  message?: string;
  errors24h: number;
  /** Enlaces a n8n; ausentes si la URL base no es http(s). */
  flowUrl?: string;
  execUrl?: string;
}

/** Solo http(s): la URL llega del servidor, pero un enlace nunca debe poder ser `javascript:`. */
function safeBase(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : undefined;
}

/** Flujos activos con la última ejecución fallida o errores en 24 h, los más recientes primero. */
export function errorRows(services: readonly AuditService[], now: number, n8nUrl?: string): ErrorRow[] {
  const base = safeBase(n8nUrl);
  return services
    .filter((s) => s.activo && (s.errores_24h > 0 || FAILED.has((s.estado_ultima ?? '').toLowerCase())))
    .map((s): ErrorRow => {
      const e = s.ultimo_error;
      return {
        id: s.workflow_id,
        name: s.workflow_nombre,
        when: e ? `falló ${ago(e.at, now)}` : `${s.errores_24h} error(es) en 24 h`,
        node: e?.nodo,
        message: e?.mensaje,
        errors24h: s.errores_24h,
        flowUrl: base ? `${base}/workflow/${encodeURIComponent(s.workflow_id)}` : undefined,
        execUrl: base && e ? `${base}/workflow/${encodeURIComponent(s.workflow_id)}/executions/${encodeURIComponent(e.execution_id)}` : undefined,
      };
    })
    .sort((a, b) => (services.find((s) => s.workflow_id === b.id)?.ultimo_error?.at ?? '').localeCompare(services.find((s) => s.workflow_id === a.id)?.ultimo_error?.at ?? ''));
}

export type AuditTab = 'tecnico' | 'cotizaciones' | 'facturacion' | 'portafolio';

/** Cada pestaña se titula por lo que mide; una métrica de otro tema (salidas…) sumaría su propia pestaña. */
export const TABS: readonly { id: AuditTab; label: string; hint: string }[] = [
  { id: 'tecnico', label: 'Técnico', hint: 'Errores de flujos, ejecuciones y servicios' },
  { id: 'cotizaciones', label: 'Cotizaciones', hint: 'Cotizaciones definidas, pipeline y revisión manual' },
  { id: 'facturacion', label: 'Facturación', hint: 'Cartera, mora, clientes morosos, recordatorios y acuerdos de pago' },
  { id: 'portafolio', label: 'Portafolio', hint: 'Envío de portafolio a clientes inactivos: envíos, respuestas, intenciones y oportunidades' },
];

/** Pestañas que ve cada rol: gerencia no ve la pestaña técnica (solo se oculta en la interfaz). */
export function visibleTabs(role: string | undefined): readonly { id: AuditTab; label: string; hint: string }[] {
  return role === 'admin' ? TABS : TABS.filter((t) => t.id !== 'tecnico');
}

/** Último día con datos de cartera (las filas llegan ordenadas por fecha); undefined si no hay. */
export function latestCartera<T extends { fecha: string }>(rows: readonly T[] | undefined): T | undefined {
  return rows?.length ? rows[rows.length - 1] : undefined;
}

/** Tramos de mora con su peso sobre la cartera vencida (0–1); sin vencida, todos en 0. */
export function moraBuckets(c: { cartera_vencida: number; mora_1_30: number; mora_31_50: number; mora_51_90: number; mora_91_mas: number }): { label: string; value: number; share: number }[] {
  const total = c.cartera_vencida > 0 ? c.cartera_vencida : 0;
  return [
    { label: '1–30 días', value: c.mora_1_30 },
    { label: '31–50 días', value: c.mora_31_50 },
    { label: '51–90 días', value: c.mora_51_90 },
    { label: 'Más de 90 días', value: c.mora_91_mas },
  ].map((b) => ({ ...b, share: total ? Math.min(1, b.value / total) : 0 }));
}

export function isAuditTab(v: unknown): v is AuditTab {
  return TABS.some((t) => t.id === v);
}

/** La alerta de revisión manual es de cotizaciones; el resto (flujos, AUD03) es técnica. */
export function splitAlerts<T extends { id: string }>(alerts: readonly T[]): { tecnico: T[]; cotizaciones: T[] } {
  const isQuote = (a: T) => a.id.startsWith('revision-manual:');
  return { tecnico: alerts.filter((a) => !isQuote(a)), cotizaciones: alerts.filter(isQuote) };
}

export interface TabBadge {
  count: number;
  /** error = hay flujos fallando; warn = algo que revisar; none = sin insignia. */
  level: 'error' | 'warn' | 'none';
}

/** Insignia de cada pestaña: la técnica cuenta flujos con error o alertas técnicas; cotizaciones, las que están en revisión. */
export function tabBadges(services: readonly AuditService[], alerts: readonly { id: string }[], enRevisionManual: number, acuerdosVencidos = 0, respuestasPortafolio = 0): Record<AuditTab, TabBadge> {
  const failing = errorRows(services, 0).length;
  const techAlerts = splitAlerts(alerts).tecnico.length;
  return {
    tecnico: failing > 0 ? { count: failing, level: 'error' } : techAlerts > 0 ? { count: techAlerts, level: 'warn' } : { count: 0, level: 'none' },
    cotizaciones: enRevisionManual > 0 ? { count: enRevisionManual, level: 'warn' } : { count: 0, level: 'none' },
    facturacion: acuerdosVencidos > 0 ? { count: acuerdosVencidos, level: 'warn' } : { count: 0, level: 'none' },
    portafolio: respuestasPortafolio > 0 ? { count: respuestasPortafolio, level: 'warn' } : { count: 0, level: 'none' },
  };
}

/** "PENDIENTE_RESPUESTA_CLIENTE" -> "Pendiente respuesta cliente"; vacío -> "—". */
export function prettyLabel(code: string | undefined): string {
  const t = (code ?? '').trim().replace(/_+/g, ' ').toLowerCase().replace(/\brevision\b/g, 'revisión').replace(/\baccion\b/g, 'acción');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—';
}

export interface ReviewRow {
  id: string;
  /** Número de cotización; "Sin número" si la fila nació de una revisión (id "REV-…"). */
  number: string;
  client: string;
  owner: string;
  state: string;
  action: string;
  value: number;
  /** "hace 33 d": desde el último movimiento. */
  since: string;
  objection?: string;
}

/** Cotizaciones en revisión manual, las que llevan más tiempo sin moverse primero. */
export function reviewRows(list: readonly AuditReviewQuote[], now: number): ReviewRow[] {
  const t = (q: AuditReviewQuote) => Date.parse(q.fecha_ultimo_movimiento ?? '');
  return [...list]
    .sort((a, b) => (Number.isFinite(t(a)) ? t(a) : Infinity) - (Number.isFinite(t(b)) ? t(b) : Infinity))
    .map((q) => ({
      id: q.cotizacion_id,
      number: q.numero_cotizacion ?? 'Sin número',
      client: q.cliente ?? '—',
      owner: q.comercial ?? '—',
      state: prettyLabel(q.estado_actual),
      action: prettyLabel(q.proxima_accion),
      value: q.valor,
      since: q.fecha_ultimo_movimiento ? ago(q.fecha_ultimo_movimiento, now) : '—',
      objection: q.objecion_actual ? q.objecion_actual : undefined,
    }));
}
