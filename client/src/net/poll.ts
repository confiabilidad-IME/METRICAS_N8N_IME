// Modo "consulta periódica" (Vercel, AccessInfo.polling): sin SSE no llegan eventos de feed ni avisos, así que se deducen
// comparando el snapshot nuevo con el anterior. Funciones puras (sin red ni reloj propio), probadas en poll.test.ts.
import type { FeedItem, Notice, OfficeSnapshot } from '../../../shared/types';

/** Cada cuánto consulta la página /api/snapshot (el servidor refresca n8n si su dato tiene más de 20 s). */
export const POLL_MS = 30_000;

/** AUD04 es el webhook que este mismo tablero consulta: en el feed solo haría ruido (igual que en el servidor Node). */
const NOISE = /^AUD04\b/i;

/** Ejecuciones nuevas: agentes cuya última actividad cambió respecto al snapshot anterior. La primera carga no genera feed. */
export function diffFeed(prev: OfficeSnapshot | null, next: OfficeSnapshot): FeedItem[] {
  if (!prev) return [];
  const before = new Map(prev.agents.map((a) => [a.id, a.activity?.id]));
  const rooms = new Map(next.rooms.map((r) => [r.id, r.name]));
  const out: FeedItem[] = [];
  for (const a of next.agents) {
    const act = a.activity;
    if (!act || act.kind === 'wait' || NOISE.test(a.title ?? '')) continue;
    if (!before.has(a.id) || before.get(a.id) === act.id) continue;
    out.push({ id: act.id, agentId: a.id, roomId: a.roomId, agentName: a.name, roomName: rooms.get(a.roomId) ?? a.roomId, account: a.account, activity: act });
  }
  return out;
}

/** Alertas que no estaban en el snapshot anterior. Sin auditoría previa (primera carga) no avisa: no inunda al abrir. */
export function diffNotices(prev: OfficeSnapshot | null, next: OfficeSnapshot, now: number): Notice[] {
  if (!prev?.audit?.data || !next.audit) return [];
  const known = new Set(prev.audit.alertas.map((a) => a.id));
  return next.audit.alertas
    .filter((a) => !known.has(a.id))
    .map((a) => ({ id: `${a.id}@${a.since}`, level: a.level, text: a.text, agentId: a.workflowId, roomId: next.rooms[0]?.id, at: now }));
}
