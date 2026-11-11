// Cliente del flujo AUD04 (GET {N8N_BASE_URL}/webhook/audit/metricas). Valida y normaliza la respuesta.
import type { AuditCarteraDay, AuditData, AuditDayMetrics, AuditExecutionDay, AuditQuote, AuditReviewQuote, AuditService } from '../../shared/audit';
import type { AuditConfig } from './config';

/** Falla de la consulta a n8n; `message` es seguro para mostrar (sin token ni URL con query). */
export class AuditFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuditFetchError';
  }
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const optStr = (v: unknown): string | undefined => {
  const s = str(v).trim();
  return s ? s : undefined;
};
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1;
/** Las data tables de n8n entregan fechas como ISO; la parte de día es lo que usa el tablero. */
const day = (v: unknown): string => str(v).slice(0, 10);
const rows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)) : [];

export function normalizeAudit(raw: unknown): AuditData {
  const body = Array.isArray(raw) ? raw[0] : raw;
  if (!body || typeof body !== 'object') throw new AuditFetchError('respuesta inválida de n8n');
  const b = body as Record<string, unknown>;
  // Un 200 sin ninguna de las secciones no es AUD04 (ej. otra ruta o una página de error).
  if (!['metricas_diarias', 'servicios', 'ejecuciones_diarias', 'cotizaciones_definidas'].some((k) => k in b)) {
    throw new AuditFetchError('la respuesta no tiene el formato de AUD04');
  }
  const rango = (b.rango && typeof b.rango === 'object' ? b.rango : {}) as Record<string, unknown>;

  const metricas_diarias: AuditDayMetrics[] = rows(b.metricas_diarias)
    .map((r) => ({
      fecha: day(r.fecha),
      cotizaciones_total: num(r.cotizaciones_total),
      cotizaciones_activas: num(r.cotizaciones_activas),
      enviadas_cliente_dia: num(r.enviadas_cliente_dia),
      con_respuesta_cliente: num(r.con_respuesta_cliente),
      definidas_total: num(r.definidas_total),
      ganadas: num(r.ganadas),
      perdidas: num(r.perdidas),
      en_revision_manual: num(r.en_revision_manual),
      valor_ganado: num(r.valor_ganado),
      valor_perdido: num(r.valor_perdido),
      valor_pipeline: num(r.valor_pipeline),
      tasa_cierre: num(r.tasa_cierre),
      seguimientos_enviados: num(r.seguimientos_enviados),
      correos_enviados: num(r.correos_enviados),
      correos_recibidos: num(r.correos_recibidos),
      ejecuciones_total: num(r.ejecuciones_total),
      ejecuciones_error: num(r.ejecuciones_error),
    }))
    .filter((m) => m.fecha)
    .sort((a, c) => (a.fecha < c.fecha ? -1 : a.fecha > c.fecha ? 1 : 0));

  const ejecuciones_diarias: AuditExecutionDay[] = rows(b.ejecuciones_diarias)
    .map((r) => ({
      workflow_id: str(r.workflow_id),
      workflow_nombre: str(r.workflow_nombre),
      fecha: day(r.fecha),
      total: num(r.total),
      exitosas: num(r.exitosas),
      errores: num(r.errores),
      duracion_prom_seg: num(r.duracion_prom_seg),
      ultima_ejecucion: optStr(r.ultima_ejecucion),
    }))
    .filter((e) => e.workflow_id && e.fecha);

  const servicios: AuditService[] = rows(b.servicios)
    .map((r) => ({
      workflow_id: str(r.workflow_id),
      workflow_nombre: str(r.workflow_nombre),
      activo: bool(r.activo),
      ultima_ejecucion: optStr(r.ultima_ejecucion),
      estado_ultima: optStr(r.estado_ultima),
      errores_24h: num(r.errores_24h),
      actualizado_en: optStr(r.actualizado_en),
    }))
    .filter((s) => s.workflow_id);

  const cotizaciones_definidas: AuditQuote[] = rows(b.cotizaciones_definidas)
    .map((r) => ({
      cotizacion_id: str(r.cotizacion_id),
      numero_cotizacion: optStr(r.numero_cotizacion),
      cliente: optStr(r.cliente),
      comercial: optStr(r.comercial),
      resultado_final: (str(r.resultado_final).toUpperCase() === 'GANADA' ? 'GANADA' : 'PERDIDA') as AuditQuote['resultado_final'],
      valor: num(r.valor),
      numero_oc: optStr(r.numero_oc),
      motivo_perdida: optStr(r.motivo_perdida),
      fecha_envio_cliente: optStr(r.fecha_envio_cliente),
      fecha_definicion: optStr(r.fecha_definicion),
    }))
    .filter((q) => q.cotizacion_id);

  // Solo si AUD04 lo trae; deduplicado por id (un nodo con varios items podría repetir filas).
  let cotizaciones_revision: AuditReviewQuote[] | undefined;
  if ('cotizaciones_revision' in b) {
    const vistas = new Set<string>();
    cotizaciones_revision = rows(b.cotizaciones_revision)
      .map((r) => ({
        cotizacion_id: str(r.cotizacion_id),
        numero_cotizacion: optStr(r.numero_cotizacion),
        cliente: optStr(r.cliente),
        comercial: optStr(r.comercial),
        valor: num(r.valor),
        estado_actual: optStr(r.estado_actual),
        requiere_revision: r.requiere_revision === true,
        proxima_accion: optStr(r.proxima_accion),
        objecion_actual: optStr(r.objecion_actual),
        fecha_envio_cliente: optStr(r.fecha_envio_cliente),
        fecha_ultimo_movimiento: optStr(r.fecha_ultimo_movimiento),
      }))
      .filter((q) => q.cotizacion_id && !vistas.has(q.cotizacion_id) && (vistas.add(q.cotizacion_id), true));
  }

  // Cartera (AUD05 vía AUD04): solo si el flujo la trae.
  let cartera_diaria: AuditCarteraDay[] | undefined;
  if ('cartera_diaria' in b) {
    cartera_diaria = rows(b.cartera_diaria)
      .map((r) => ({
        fecha: day(r.fecha),
        cartera_abierta: num(r.cartera_abierta),
        cartera_vencida: num(r.cartera_vencida),
        pct_vencida: num(r.pct_vencida),
        facturas_abiertas: num(r.facturas_abiertas),
        facturas_vencidas: num(r.facturas_vencidas),
        clientes_con_saldo: num(r.clientes_con_saldo),
        clientes_morosos: num(r.clientes_morosos),
        saldo_morosos: num(r.saldo_morosos),
        mora_1_30: num(r.mora_1_30),
        mora_31_50: num(r.mora_31_50),
        mora_51_90: num(r.mora_51_90),
        mora_91_mas: num(r.mora_91_mas),
        recordatorios_enviados_dia: num(r.recordatorios_enviados_dia),
        envios_30d: num(r.envios_30d),
        envios_respondidos_30d: num(r.envios_respondidos_30d),
        envios_rebotados_30d: num(r.envios_rebotados_30d),
        envios_pendientes_30d: num(r.envios_pendientes_30d),
        tasa_respuesta_30d: num(r.tasa_respuesta_30d),
        respuestas_dia: num(r.respuestas_dia),
        respuestas_por_revisar: num(r.respuestas_por_revisar),
        cartas_enviadas_dia: num(r.cartas_enviadas_dia),
        clientes_revision_manual: num(r.clientes_revision_manual),
        acuerdos_vigentes: num(r.acuerdos_vigentes),
        acuerdos_vencidos_sin_pago: num(r.acuerdos_vencidos_sin_pago),
        valor_comprometido: num(r.valor_comprometido),
        cartera_al: optStr(r.cartera_al),
      }))
      .filter((c) => c.fecha)
      .sort((a, c) => (a.fecha < c.fecha ? -1 : a.fecha > c.fecha ? 1 : 0));
  }
  let cartera_morosos: AuditData['cartera_morosos'];
  if (b.cartera_morosos && typeof b.cartera_morosos === 'object') {
    const m = b.cartera_morosos as Record<string, unknown>;
    cartera_morosos = {
      fecha: optStr(m.fecha) ? day(m.fecha) : null,
      cartera_al: optStr(m.cartera_al) ? day(m.cartera_al) : null,
      clientes: rows(m.clientes)
        .map((r) => ({
          nit: str(r.nit),
          cliente: str(r.cliente),
          facturas: num(r.facturas),
          saldo_total: num(r.saldo_total),
          saldo_moroso: num(r.saldo_moroso),
          mora_max_dias: num(r.mora_max_dias),
          cartas_enviadas: num(r.cartas_enviadas),
          revision_manual: bool(r.revision_manual),
        }))
        .filter((c) => c.cliente || c.nit)
        .sort((a, c) => c.saldo_moroso - a.saldo_moroso),
    };
  }

  return {
    generado_en: str(b.generado_en) || new Date().toISOString(),
    rango: { desde: optStr(rango.desde) ?? null, hasta: optStr(rango.hasta) ?? null },
    metricas_diarias,
    ejecuciones_diarias,
    servicios,
    cotizaciones_definidas,
    ...(cotizaciones_revision ? { cotizaciones_revision } : {}),
    ...(cartera_diaria ? { cartera_diaria } : {}),
    ...(cartera_morosos ? { cartera_morosos } : {}),
  };
}

/** `YYYY-MM-DD` válido (también como fecha real: rechaza 2026-13-45). */
export function isIsoDay(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function fetchAudit(
  cfg: Pick<AuditConfig, 'baseUrl' | 'webhookPath' | 'token' | 'requestTimeoutMs'>,
  range: { desde?: string; hasta?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AuditData> {
  const url = new URL(cfg.baseUrl + cfg.webhookPath);
  if (isIsoDay(range.desde)) url.searchParams.set('desde', range.desde);
  if (isIsoDay(range.hasta)) url.searchParams.set('hasta', range.hasta);
  let res: Response;
  try {
    // El token va por header (no en la query) para que no quede en los registros de acceso de n8n ni de proxies.
    res = await fetchImpl(url, {
      headers: { 'x-audit-token': cfg.token, accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new AuditFetchError(name === 'TimeoutError' || name === 'AbortError' ? 'n8n no respondió a tiempo' : 'no se pudo conectar con n8n');
  }
  if (res.status === 401) throw new AuditFetchError('token de auditoría rechazado por n8n (401)', 401);
  if (res.status === 404) throw new AuditFetchError('webhook de AUD04 no encontrado o flujo inactivo (404)', 404);
  if (!res.ok) throw new AuditFetchError(`n8n respondió ${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AuditFetchError('n8n no devolvió JSON');
  }
  return normalizeAudit(body);
}
