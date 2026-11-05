// Cálculos puros sobre la respuesta de AUD04: fechas en APP_TIMEZONE, KPIs y alertas. Sin red ni reloj propio (todo recibe `now`).
import type { AuditAlert, AuditData, AuditKpis, AuditReviewQuote, AuditService } from '../../shared/audit';

/** Si AUD03 no actualiza Audit_Servicios en este tiempo, el estado mostrado ya no es de fiar (AUD03 corre cada hora). */
export const SERVICES_STALE_MS = 3 * 3600_000;

const ERROR_STATES = new Set(['error', 'crashed']);

/** Cuántas cotizaciones nombra la alerta de revisión manual antes de resumir con "y N más". */
const REVIEW_NAMES = 3;

/** "PGI COLOMBIA LTDA (82950)"; sin número de cotización, solo el cliente. */
export function reviewLabel(q: AuditReviewQuote): string {
  const who = q.cliente ?? 'cliente sin nombre';
  return q.numero_cotizacion ? `${who} (${q.numero_cotizacion})` : who;
}

/** Texto de la alerta de revisión manual; si se conoce la lista, nombra las primeras cotizaciones. */
export function reviewAlertText(count: number, list: readonly AuditReviewQuote[] | undefined): string {
  const base = `${count} cotización(es) en revisión manual`;
  if (!list?.length) return base;
  const names = list.slice(0, REVIEW_NAMES).map(reviewLabel).join(', ');
  return `${base}: ${names}${list.length > REVIEW_NAMES ? ` y ${list.length - REVIEW_NAMES} más` : ''}`;
}

/** ' (nodo X: mensaje)' cuando n8n informa dónde falló; vacío si no. */
export function errorWhere(s: AuditService): string {
  const e = s.ultimo_error;
  if (!e || (!e.nodo && !e.mensaje)) return '';
  const msg = e.mensaje ? (e.mensaje.length > 90 ? `${e.mensaje.slice(0, 89)}…` : e.mensaje) : '';
  return ` (${[e.nodo ? `nodo «${e.nodo}»` : '', msg].filter(Boolean).join(': ')})`;
}

/** `YYYY-MM-DD` de un instante en la zona horaria dada. */
export function dayIn(timezone: string, at: number | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Suma `days` (puede ser negativo) a un `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ratio = (won: number, lost: number): number | null => (won + lost > 0 ? Math.round((won / (won + lost)) * 10000) / 10000 : null);
const sum = <T>(items: T[], pick: (x: T) => number): number => items.reduce((a, x) => a + pick(x), 0);

/** Un servicio activo cuya última ejecución falló o que tuvo errores en las últimas 24 h. */
export function serviceHasError(s: AuditService): boolean {
  return s.activo && (s.errores_24h > 0 || ERROR_STATES.has((s.estado_ultima ?? '').toLowerCase()));
}

export function computeKpis(data: AuditData): AuditKpis {
  const days = data.metricas_diarias; // ya vienen ordenadas por fecha
  const last = days[days.length - 1];
  const quotes = data.cotizaciones_definidas;
  const won = quotes.filter((q) => q.resultado_final === 'GANADA');
  const lost = quotes.filter((q) => q.resultado_final === 'PERDIDA');
  const services = data.servicios;
  return {
    definidasPeriodo: quotes.length,
    ganadasPeriodo: won.length,
    perdidasPeriodo: lost.length,
    tasaCierrePeriodo: ratio(won.length, lost.length),
    valorGanadoPeriodo: sum(won, (q) => q.valor),
    valorPerdidoPeriodo: sum(lost, (q) => q.valor),
    definidasAcum: last?.definidas_total ?? 0,
    ganadasAcum: last?.ganadas ?? 0,
    perdidasAcum: last?.perdidas ?? 0,
    tasaCierreAcum: last ? ratio(last.ganadas, last.perdidas) : null,
    valorGanadoAcum: last?.valor_ganado ?? 0,
    valorPerdidoAcum: last?.valor_perdido ?? 0,
    valorPipeline: last?.valor_pipeline ?? 0,
    cotizacionesActivas: last?.cotizaciones_activas ?? 0,
    enRevisionManual: last?.en_revision_manual ?? 0,
    fotoFecha: last?.fecha ?? null,
    enviadasCliente: sum(days, (d) => d.enviadas_cliente_dia),
    correosEnviados: sum(days, (d) => d.correos_enviados),
    correosRecibidos: sum(days, (d) => d.correos_recibidos),
    seguimientosEnviados: sum(days, (d) => d.seguimientos_enviados),
    ejecucionesTotal: sum(data.ejecuciones_diarias, (e) => e.total),
    ejecucionesError: sum(data.ejecuciones_diarias, (e) => e.errores),
    serviciosTotal: services.length,
    serviciosActivos: services.filter((s) => s.activo).length,
    serviciosConError: services.filter(serviceHasError).length,
  };
}

/**
 * Alertas de la foto actual. `previous` conserva `since` de las que siguen vigentes (el aviso al usuario solo se emite
 * cuando una alerta aparece por primera vez, no en cada sondeo).
 */
export function deriveAlerts(data: AuditData, now: number, previous: readonly AuditAlert[] = []): AuditAlert[] {
  const since = new Map(previous.map((a) => [a.id, a.since]));
  const out: AuditAlert[] = [];
  const push = (a: Omit<AuditAlert, 'since'>) => out.push({ ...a, since: since.get(a.id) ?? now });

  for (const s of data.servicios) {
    if (!s.activo) continue;
    if (ERROR_STATES.has((s.estado_ultima ?? '').toLowerCase())) {
      push({ id: `ultima-fallida:${s.workflow_id}`, level: 'alert', text: `${s.workflow_nombre}: la última ejecución falló${errorWhere(s)}`, workflowId: s.workflow_id });
    } else if (s.errores_24h > 0) {
      push({ id: `errores-24h:${s.workflow_id}`, level: 'warn', text: `${s.workflow_nombre}: ${s.errores_24h} error(es) en 24 h${errorWhere(s)}`, workflowId: s.workflow_id });
    }
  }

  const last = data.metricas_diarias[data.metricas_diarias.length - 1];
  // La lista (AUD04 ampliado) manda sobre el conteo de AUD01: es la foto de ahora, no la de la última corrida horaria.
  const enRevision = data.cotizaciones_revision?.length ?? last?.en_revision_manual ?? 0;
  if (enRevision > 0) push({ id: 'revision-manual:global', level: 'warn', text: reviewAlertText(enRevision, data.cotizaciones_revision) });

  // AUD03 detenido: los servicios se ven "bien" solo porque nadie los actualiza.
  const stamps = data.servicios.map((s) => Date.parse(s.actualizado_en ?? '')).filter(Number.isFinite);
  if (data.servicios.length === 0) {
    push({ id: 'servicios-vacio:global', level: 'warn', text: 'Audit_Servicios está vacío: ¿AUD03 está activo y ya corrió?' });
  } else if (stamps.length && now - Math.max(...stamps) > SERVICES_STALE_MS) {
    push({ id: 'servicios-desactualizados:global', level: 'warn', text: 'El estado de servicios no se actualiza hace más de 3 h (revisar AUD03)' });
  }
  return out;
}
