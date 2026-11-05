// Datos ficticios con la forma de AUD04 (AUDIT_DEMO=1 y pruebas). Determinístico para un mismo `now`: sin Math.random.
import type { AuditData, AuditDayMetrics, AuditExecutionDay, AuditQuote, AuditReviewQuote, AuditService } from '../../shared/audit';
import { hash32, mulberry32 } from '../../shared/hash';
import { addDays, dayIn } from './derive';

const FLOWS: Array<{ id: string; nombre: string; activo: boolean; falla?: boolean }> = [
  { id: 'demo-aud01', nombre: 'AUD01 - Métricas diarias de cotizaciones y automatización', activo: true },
  { id: 'demo-aud02', nombre: 'AUD02 - Auditoría de correos enviados y recibidos', activo: true },
  { id: 'demo-aud03', nombre: 'AUD03 - Auditoría de ejecuciones y estado de servicios', activo: true },
  { id: 'demo-aud04', nombre: 'AUD04 - API de métricas de auditoría', activo: true },
  { id: 'demo-etq-cot', nombre: 'Etiquetado_cotizacion', activo: true, falla: true },
  { id: 'demo-etq-com', nombre: 'Etiquetado_comercial', activo: true },
  { id: 'demo-wf06', nombre: 'WF06 - Motor Central de Estados', activo: true },
  { id: 'demo-wf04', nombre: 'WF04 - Motor de Seguimientos', activo: false },
];

export function demoAudit(now: number, timezone: string, desde?: string): AuditData {
  const hoy = dayIn(timezone, now);
  const from = desde ?? addDays(hoy, -13);
  const rand = mulberry32(hash32(`demo:${hoy}`));
  const days: string[] = [];
  for (let d = from; d <= hoy && days.length < 400; d = addDays(d, 1)) days.push(d);

  let ganadas = 40;
  let perdidas = 25;
  const metricas_diarias: AuditDayMetrics[] = days.map((fecha) => {
    const g = rand() < 0.4 ? 1 : 0;
    const p = rand() < 0.3 ? 1 : 0;
    ganadas += g;
    perdidas += p;
    const definidas = ganadas + perdidas;
    return {
      fecha,
      cotizaciones_total: definidas + 18,
      cotizaciones_activas: 18,
      enviadas_cliente_dia: Math.floor(rand() * 6),
      con_respuesta_cliente: 30,
      definidas_total: definidas,
      ganadas,
      perdidas,
      en_revision_manual: rand() < 0.2 ? 1 : 0,
      valor_ganado: ganadas * 4_200_000,
      valor_perdido: perdidas * 3_100_000,
      valor_pipeline: 18 * 3_800_000,
      tasa_cierre: Math.round((ganadas / definidas) * 10000) / 10000,
      seguimientos_enviados: Math.floor(rand() * 5),
      correos_enviados: 10 + Math.floor(rand() * 30),
      correos_recibidos: 20 + Math.floor(rand() * 50),
      ejecuciones_total: 150 + Math.floor(rand() * 60),
      ejecuciones_error: rand() < 0.3 ? 1 + Math.floor(rand() * 3) : 0,
    };
  });

  const ejecuciones_diarias: AuditExecutionDay[] = days.flatMap((fecha) =>
    FLOWS.filter((f) => f.activo).map((f) => {
      const total = 8 + Math.floor(rand() * 40);
      const errores = f.falla && rand() < 0.5 ? 1 + Math.floor(rand() * 3) : 0;
      return { workflow_id: f.id, workflow_nombre: f.nombre, fecha, total, exitosas: total - errores, errores, duracion_prom_seg: Math.round((1 + rand() * 9) * 10) / 10 };
    }),
  );

  const servicios: AuditService[] = FLOWS.map((f, i) => ({
    workflow_id: f.id,
    workflow_nombre: f.nombre,
    activo: f.activo,
    ultima_ejecucion: f.activo ? new Date(now - (i + 1) * 7 * 60_000).toISOString() : undefined,
    estado_ultima: f.activo ? (f.falla ? 'error' : 'success') : undefined,
    errores_24h: f.falla ? 2 : 0,
    actualizado_en: new Date(now - 20 * 60_000).toISOString(),
  }));

  const clientes = ['Ecopetrol', 'Cenit', 'Argos', 'Cerrejón', 'Bavaria', 'Sika'];
  const cotizaciones_definidas: AuditQuote[] = Array.from({ length: 12 }, (_, i) => {
    const gano = rand() < 0.55;
    return {
      cotizacion_id: `demo-cot-${i + 1}`,
      numero_cotizacion: `COT-${2026000 + i + 1}`,
      cliente: clientes[i % clientes.length],
      comercial: i % 2 ? 'Julian Alvarez' : 'Willian Hurtado',
      resultado_final: gano ? 'GANADA' : 'PERDIDA',
      valor: Math.round((1 + rand() * 9) * 1_000_000),
      numero_oc: gano ? `OC-${5000 + i}` : undefined,
      motivo_perdida: gano ? undefined : 'Precio',
      fecha_definicion: `${days[Math.min(days.length - 1, i)]}T15:00:00.000Z`,
    };
  });

  const revision: AuditReviewQuote[] = [
    { cotizacion_id: 'demo-rev-1', numero_cotizacion: '82807', cliente: 'Cervecería del Valle', comercial: 'Willian Hurtado', valor: 5_511_069, estado_actual: 'REVISION_MANUAL', requiere_revision: true, proxima_accion: 'REVISION_MANUAL', fecha_ultimo_movimiento: new Date(now - 20 * 86_400_000).toISOString() },
    { cotizacion_id: 'demo-rev-2', cliente: 'Consorcio Omia', comercial: 'Julian Alvarez', valor: 0, estado_actual: 'PENDIENTE_RESPUESTA_CLIENTE', requiere_revision: true, proxima_accion: 'REVISION_HUMANA', fecha_ultimo_movimiento: new Date(now - 33 * 86_400_000).toISOString() },
  ];
  // El conteo de AUD01 coincide con la lista.
  if (metricas_diarias.length) metricas_diarias[metricas_diarias.length - 1].en_revision_manual = revision.length;
  return { generado_en: new Date(now).toISOString(), rango: { desde: from, hasta: null }, metricas_diarias, ejecuciones_diarias, servicios, cotizaciones_definidas, cotizaciones_revision: revision };
}
