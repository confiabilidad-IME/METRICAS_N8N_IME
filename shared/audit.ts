// Tipos de la auditoría n8n: la respuesta normalizada del flujo AUD04 más lo que el servidor deriva de ella.
// Código puro (sin Node ni DOM). Los nombres de campo siguen las columnas de las data tables de n8n (Audit_*).
import type { NoticeLevel } from './types';

/**
 * Una fila de Audit_Metricas_Diarias (AUD01 la actualiza cada hora; la fila del día se sobrescribe).
 * Ojo: cotizaciones_*, con_respuesta_cliente, definidas_total, ganadas, perdidas, en_revision_manual, valor_* y
 * tasa_cierre son una FOTO ACUMULADA de todas las cotizaciones a esa fecha (no se suman entre días). Son cifras del día
 * solo enviadas_cliente_dia, seguimientos_enviados, correos_* y ejecuciones_*.
 */
export interface AuditDayMetrics {
  /** YYYY-MM-DD en APP_TIMEZONE. */
  fecha: string;
  cotizaciones_total: number;
  cotizaciones_activas: number;
  enviadas_cliente_dia: number;
  con_respuesta_cliente: number;
  definidas_total: number;
  ganadas: number;
  perdidas: number;
  en_revision_manual: number;
  valor_ganado: number;
  valor_perdido: number;
  valor_pipeline: number;
  /** 0–1 (ganadas / definidas). */
  tasa_cierre: number;
  seguimientos_enviados: number;
  correos_enviados: number;
  correos_recibidos: number;
  ejecuciones_total: number;
  ejecuciones_error: number;
}

/** Una fila de Audit_Ejecuciones_Diario (la escribe AUD03 cada hora): un flujo en un día. */
export interface AuditExecutionDay {
  workflow_id: string;
  workflow_nombre: string;
  fecha: string;
  total: number;
  exitosas: number;
  errores: number;
  duracion_prom_seg: number;
  /** ISO 8601. */
  ultima_ejecucion?: string;
}

/** Qué falló en la última ejecución con error de un flujo (solo con la API de n8n en vivo). */
export interface AuditLastError {
  execution_id: string;
  /** ISO 8601: cuándo empezó la ejecución fallida. */
  at: string;
  /** Nodo donde falló, si n8n lo informa. */
  nodo?: string;
  /** Mensaje de n8n, recortado (puede venir vacío). */
  mensaje?: string;
}

/** Una fila de Audit_Servicios (la escribe AUD03 cada hora): el estado de un flujo. */
export interface AuditService {
  workflow_id: string;
  workflow_nombre: string;
  activo: boolean;
  /** ISO 8601; ausente si nunca se ejecutó. */
  ultima_ejecucion?: string;
  /** success | error | crashed | waiting | ... (estado n8n de la última ejecución). */
  estado_ultima?: string;
  errores_24h: number;
  /** ISO 8601: cuándo AUD03 escribió la fila. */
  actualizado_en?: string;
  /** La ejecución fallida más reciente (últimas 24 h o la última del flujo), con nodo y mensaje. */
  ultimo_error?: AuditLastError;
}

/** Una cotización definida (resultado_final GANADA o PERDIDA), tal como la devuelve AUD04. */
export interface AuditQuote {
  cotizacion_id: string;
  numero_cotizacion?: string;
  cliente?: string;
  comercial?: string;
  resultado_final: 'GANADA' | 'PERDIDA';
  valor: number;
  numero_oc?: string;
  motivo_perdida?: string;
  fecha_envio_cliente?: string;
  fecha_definicion?: string;
}

/** Una cotización que requiere revisión manual (estado REVISION_MANUAL o requiere_revision), tal como la devuelve AUD04. */
export interface AuditReviewQuote {
  cotizacion_id: string;
  /** Puede venir vacío (cotizaciones creadas por revisión, id "REV-…"). */
  numero_cotizacion?: string;
  cliente?: string;
  comercial?: string;
  valor: number;
  /** Ej. REVISION_MANUAL, PENDIENTE_RESPUESTA_CLIENTE. */
  estado_actual?: string;
  requiere_revision: boolean;
  /** Ej. REVISION_MANUAL, REVISION_HUMANA. */
  proxima_accion?: string;
  objecion_actual?: string;
  fecha_envio_cliente?: string;
  /** ISO 8601: último movimiento; sirve para ver desde cuándo está pendiente. */
  fecha_ultimo_movimiento?: string;
}

/**
 * Una fila de Audit_Cartera_Diaria (AUD05 la actualiza cada hora; la fila del día se sobrescribe).
 * Todo es una FOTO de la cartera a esa fecha (saldos en pesos), salvo los campos `*_dia`, que son del día.
 */
export interface AuditCarteraDay {
  fecha: string;
  cartera_abierta: number;
  cartera_vencida: number;
  /** 0–1 (cartera_vencida / cartera_abierta). */
  pct_vencida: number;
  facturas_abiertas: number;
  facturas_vencidas: number;
  clientes_con_saldo: number;
  clientes_morosos: number;
  saldo_morosos: number;
  mora_1_30: number;
  mora_31_50: number;
  mora_51_90: number;
  mora_91_mas: number;
  recordatorios_enviados_dia: number;
  envios_30d: number;
  envios_respondidos_30d: number;
  envios_rebotados_30d: number;
  envios_pendientes_30d: number;
  /** 0–1. */
  tasa_respuesta_30d: number;
  respuestas_dia: number;
  respuestas_por_revisar: number;
  cartas_enviadas_dia: number;
  clientes_revision_manual: number;
  acuerdos_vigentes: number;
  acuerdos_vencidos_sin_pago: number;
  valor_comprometido: number;
  /** Fecha del reporte de cartera de origen (YYYY-MM-DD), si AUD05 la informa. */
  cartera_al?: string;
}

/** Un cliente moroso del último reporte (Audit_Cartera_Diaria.detalle_morosos). */
export interface AuditMoroso {
  nit: string;
  cliente: string;
  facturas: number;
  saldo_total: number;
  saldo_moroso: number;
  mora_max_dias: number;
  cartas_enviadas: number;
  revision_manual: boolean;
}

/**
 * Una fila de Audit_Portafolio_Diario (AUD06 la actualiza cada hora): envío de portafolio a clientes inactivos.
 * Los `*_dia` son del día; `*_7d` / `*_30d` son ventanas móviles; el resto es una foto a esa fecha.
 */
export interface AuditPortafolioDay {
  fecha: string;
  envios_dia: number;
  envios_7d: number;
  envios_30d: number;
  envios_total: number;
  respondidos_30d: number;
  rebotados_30d: number;
  pendientes_30d: number;
  /** 0–1. */
  tasa_respuesta_30d: number;
  respuestas_dia: number;
  rebotes_dia: number;
  autorrespuestas_dia: number;
  respuestas_7d: number;
  intencion_interesado_30d: number;
  intencion_solicita_cotizacion_30d: number;
  intencion_no_interesado_30d: number;
  intencion_remitir_30d: number;
  intencion_otro_30d: number;
  oportunidades_30d: number;
  /** 0–1 (oportunidades / envíos de 30 d). */
  tasa_oportunidad_30d: number;
  respuestas_sin_revisar: number;
  clientes_inactivos_total: number;
  clientes_no_contactar: number;
  clientes_contactados_mes: number;
}

/** Una respuesta humana reciente de un cliente inactivo (Audit_Portafolio_Diario.detalle_respuestas). */
export interface AuditPortafolioRespuesta {
  fecha: string;
  cliente: string;
  correo: string;
  intencion: string;
  resumen: string;
  revisada: boolean;
}

/**
 * Rol del usuario con sesión. `admin` ve todas las pestañas del modal; `gerencia` no ve la pestaña técnica de los flujos.
 * Es una restricción de la interfaz, no del servidor.
 */
export type AuditRole = 'admin' | 'gerencia';

/** Normalización de la respuesta completa de AUD04 (sin derivados). */
export interface AuditData {
  /** ISO 8601, reloj de n8n. */
  generado_en: string;
  rango: { desde: string | null; hasta: string | null };
  metricas_diarias: AuditDayMetrics[];
  ejecuciones_diarias: AuditExecutionDay[];
  servicios: AuditService[];
  cotizaciones_definidas: AuditQuote[];
  /** Ausente si AUD04 aún no incluye el campo (versión anterior del flujo): no es lo mismo que "ninguna". */
  cotizaciones_revision?: AuditReviewQuote[];
  /** Ausente si AUD04 aún no publica la cartera (AUD05): distinto de "cartera vacía". */
  cartera_diaria?: AuditCarteraDay[];
  cartera_morosos?: { fecha: string | null; cartera_al: string | null; clientes: AuditMoroso[] };
  /** Ausente si AUD04 aún no publica el portafolio (AUD06). */
  portafolio_diario?: AuditPortafolioDay[];
  portafolio_respuestas_recientes?: { fecha: string | null; respuestas: AuditPortafolioRespuesta[] };
}

/** Indicadores de negocio y de operación calculados sobre el rango consultado. */
export interface AuditKpis {
  // --- Del período: cotizaciones definidas dentro del rango (AuditData.cotizaciones_definidas).
  definidasPeriodo: number;
  ganadasPeriodo: number;
  perdidasPeriodo: number;
  /** 0–1; null si no hubo definidas. */
  tasaCierrePeriodo: number | null;
  valorGanadoPeriodo: number;
  valorPerdidoPeriodo: number;
  // --- Acumulado: la última foto de Audit_Metricas_Diarias (no se suma entre días).
  definidasAcum: number;
  ganadasAcum: number;
  perdidasAcum: number;
  tasaCierreAcum: number | null;
  valorGanadoAcum: number;
  valorPerdidoAcum: number;
  valorPipeline: number;
  cotizacionesActivas: number;
  enRevisionManual: number;
  /** Fecha (YYYY-MM-DD) de la foto usada para el acumulado; null si no hay filas. */
  fotoFecha: string | null;
  // --- Suma de las cifras diarias del rango.
  enviadasCliente: number;
  correosEnviados: number;
  correosRecibidos: number;
  seguimientosEnviados: number;
  ejecucionesTotal: number;
  ejecucionesError: number;
  serviciosTotal: number;
  serviciosActivos: number;
  /** Servicios activos con errores en las últimas 24 h o con la última ejecución fallida. */
  serviciosConError: number;
}

export interface AuditAlert {
  /** Estable mientras la condición persista: `<tipo>:<workflow_id|global>`. */
  id: string;
  level: NoticeLevel;
  /** Texto corto en español (los datos vienen de n8n, no del diccionario de la UI). */
  text: string;
  workflowId?: string;
  /** Epoch ms en que se vio por primera vez. */
  since: number;
}

/**
 * Estado del sondeo a n8n:
 * - disabled: falta configuración (no hay token o URL);
 * - pending: aún sin primera respuesta;
 * - ok: respuesta reciente;
 * - stale: la última consulta falló pero hay datos anteriores;
 * - error: la última consulta falló y no hay datos.
 */
export type AuditStatus = 'disabled' | 'pending' | 'ok' | 'stale' | 'error';

export interface AuditSnapshot {
  status: AuditStatus;
  /** Epoch ms de la última respuesta buena. */
  fetchedAt?: number;
  /** Motivo corto del último fallo (nunca incluye el token). */
  error?: string;
  /** De dónde salen `servicios` y las ejecuciones de hoy: la API de n8n en vivo, o lo que dejó AUD03 en sus tablas. */
  fuenteServicios?: 'api' | 'AUD03';
  /** Por qué no se usó la API en vivo, si estaba configurada (sin la llave). */
  errorApi?: string;
  /** URL base de n8n (no es secreta): el panel la usa para enlazar flujos y ejecuciones. */
  n8nUrl?: string;
  /** Rango efectivo de la consulta (YYYY-MM-DD). */
  desde: string;
  hasta?: string;
  data?: AuditData;
  kpis?: AuditKpis;
  alertas: AuditAlert[];
}
