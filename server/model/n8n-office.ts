// El "escritorio" visto desde n8n: traduce la auditoría (AuditSnapshot) al OfficeSnapshot que el cliente ya sabe dibujar.
// Una sola sala ("n8n") y un personaje por flujo ACTIVO; los inactivos solo aparecen en el panel. Un flujo con la última
// ejecución fallida levanta la mano (waiting) y, si hay alguno, la sala muestra la alarma. Misma interfaz que usa el Hub
// (onChange / commit / recentFeed), así que sse.ts no sabe de dónde vienen los datos.
import type { AuditService, AuditSnapshot } from '../../shared/audit';
import { hash32 } from '../../shared/hash';
import type { Activity, AgentInfo, AgentStatus, FeedItem, Notice, OfficeSnapshot, RoomInfo } from '../../shared/types';
import type { AuditPoller } from '../audit/poller';
import { errorWhere, serviceHasError } from '../audit/derive';

export const ROOM_ID = 'n8n';
const ACCOUNT_ID = 'n8n';
/** Una ejecución más reciente que esto se ve como "trabajando". */
const WORKING_MS = 5 * 60_000;
const ALARM_MS = 10 * 60_000;
const FEED_MAX = 100;
const MAX_AGENTS = 40;

export interface CommitResult {
  changed: boolean;
  snapshot: OfficeSnapshot;
  feed: FeedItem[];
  notices: Notice[];
}

export interface OfficeOptions {
  version: string;
  baseUrl: string;
  demo: boolean;
  now?: () => number;
}

/** "AUD03 - Auditoría de..." -> "AUD03"; "Etiquetado_cotizacion" -> "Etiquetado_cotiz…". */
export function shortName(nombre: string): string {
  const code = /^([A-Za-z]{2,4}\d{1,3})\b/.exec(nombre.trim());
  if (code) return code[1].toUpperCase();
  const s = nombre.trim();
  return s.length > 16 ? `${s.slice(0, 15)}…` : s;
}

/** Texto de la faja de alarma: nombra los flujos con error (la faja es corta: hasta 2 nombres y '+N'). */
export function alarmText(failing: readonly AuditService[]): string {
  const names = failing.map((s) => shortName(s.workflow_nombre));
  if (names.length <= 2) return `Error en ${names.join(' y ')}`;
  return `Error en ${names.slice(0, 2).join(', ')} y ${names.length - 2} más`;
}

const isError = (s: AuditService): boolean => ['error', 'crashed'].includes((s.estado_ultima ?? '').toLowerCase());

export class N8nOffice {
  private rev = 0;
  private readonly startedAt: number;
  private readonly now: () => number;
  private listeners = new Set<() => void>();
  private feed: FeedItem[] = [];
  private lastSig = '';
  private last: OfficeSnapshot;
  private statusSince = new Map<string, { status: AgentStatus; since: number }>();
  private lastExec = new Map<string, string>();
  private knownAlerts = new Set<string>();
  private alarmAt = 0;
  private primed = false;

  constructor(
    private readonly poller: AuditPoller,
    private readonly opts: OfficeOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.last = this.build(this.poller.snapshot(), this.now());
    poller.onChange(() => this.listeners.forEach((cb) => cb()));
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  recentFeed(n: number): FeedItem[] {
    return this.feed.slice(-n);
  }

  /** Cierra la revisión: reconstruye el snapshot y devuelve lo nuevo desde la anterior. */
  commit(): CommitResult {
    const now = this.now();
    const audit = this.poller.snapshot();
    const snapshot = this.build(audit, now);
    const sig = JSON.stringify({ r: snapshot.rooms, a: snapshot.agents, au: snapshot.audit, m: snapshot.meta.sources });
    if (sig === this.lastSig) return { changed: false, snapshot: this.last, feed: [], notices: [] };
    this.lastSig = sig;
    snapshot.rev = ++this.rev;
    this.last = snapshot;

    const feed = this.newFeed(snapshot);
    const notices = this.newNotices(audit, now);
    this.primed = audit.data !== undefined || this.primed;
    return { changed: true, snapshot, feed, notices };
  }

  /** Ejecuciones nuevas desde el commit anterior (la primera carga no inunda el feed: solo toma la referencia). */
  private newFeed(snapshot: OfficeSnapshot): FeedItem[] {
    const items: FeedItem[] = [];
    const services = snapshot.audit?.data?.servicios ?? [];
    for (const s of services) {
      if (!s.activo || !s.ultima_ejecucion) continue;
      // AUD04 es el webhook que consulta este mismo tablero cada minuto: en el feed solo haría ruido.
      if (/^AUD04\b/i.test(s.workflow_nombre)) continue;
      const prev = this.lastExec.get(s.workflow_id);
      this.lastExec.set(s.workflow_id, s.ultima_ejecucion);
      if (!this.primed || prev === undefined || prev === s.ultima_ejecucion) continue;
      const agent = snapshot.agents.find((a) => a.id === s.workflow_id);
      if (!agent || !agent.activity) continue;
      items.push({ id: `${s.workflow_id}:${s.ultima_ejecucion}`, agentId: agent.id, roomId: ROOM_ID, agentName: agent.name, roomName: snapshot.rooms[0]?.name ?? 'n8n', account: ACCOUNT_ID, activity: agent.activity });
    }
    this.feed.push(...items);
    if (this.feed.length > FEED_MAX) this.feed.splice(0, this.feed.length - FEED_MAX);
    return items;
  }

  /** Alertas que aparecen por primera vez (y solo después de la primera carga buena). */
  private newNotices(audit: AuditSnapshot, now: number): Notice[] {
    const out: Notice[] = [];
    const current = new Set<string>();
    for (const a of audit.alertas) {
      current.add(a.id);
      if (this.knownAlerts.has(a.id) || !this.primed) continue;
      out.push({ id: `${a.id}@${a.since}`, level: a.level, text: a.text, agentId: a.workflowId, roomId: ROOM_ID, at: now });
    }
    this.knownAlerts = current;
    return out;
  }

  private build(audit: AuditSnapshot, now: number): OfficeSnapshot {
    const services = (audit.data?.servicios ?? []).filter((s) => s.activo).slice(0, MAX_AGENTS);
    const execToday = new Map<string, number>();
    const days = audit.data?.ejecuciones_diarias ?? [];
    const lastDay = days.reduce((m, e) => (e.fecha > m ? e.fecha : m), '');
    for (const e of days) if (e.fecha === lastDay) execToday.set(e.workflow_id, e.total);

    const used = new Set<string>();
    const agents: AgentInfo[] = services.map((s) => {
      const seed = hash32(s.workflow_id);
      let name = shortName(s.workflow_nombre);
      for (let i = 2; used.has(name); i++) name = `${shortName(s.workflow_nombre)} ${i}`;
      used.add(name);

      const failed = isError(s);
      const at = Date.parse(s.ultima_ejecucion ?? '') || this.startedAt;
      const status: AgentStatus = failed ? 'waiting' : now - at < WORKING_MS && s.ultima_ejecucion ? 'working' : 'idle';
      const prev = this.statusSince.get(s.workflow_id);
      const since = prev && prev.status === status ? prev.since : now;
      this.statusSince.set(s.workflow_id, { status, since });

      const activity: Activity | undefined = s.ultima_ejecucion
        ? {
            id: `${s.workflow_id}:${s.ultima_ejecucion}`,
            kind: failed ? 'error' : 'run',
            icon: failed ? '⚠️' : '⚙️',
            text: failed ? 'Última ejecución con error' : 'Ejecución completada',
            detail: failed ? `${s.workflow_nombre}${errorWhere(s)}` : s.workflow_nombre,
            at,
            error: failed || undefined,
          }
        : { id: `${s.workflow_id}:sin-ejecuciones`, kind: 'wait', icon: '⏳', text: 'Sin ejecuciones registradas', detail: s.workflow_nombre, at: this.startedAt };

      return {
        id: s.workflow_id,
        kind: 'main',
        roomId: ROOM_ID,
        name,
        look: seed % 2 ? 'f' : 'm',
        role: 'Flujo n8n',
        title: s.workflow_nombre,
        sessionId: s.workflow_id,
        account: ACCOUNT_ID,
        status,
        waitingFor: failed ? 'revisar un error' : undefined,
        activity,
        recent: activity ? [activity] : [],
        tasks: [],
        startedAt: this.startedAt,
        lastEventAt: at,
        statusSince: since,
        stats: { toolCalls: execToday.get(s.workflow_id) ?? 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
        seed,
      };
    });
    for (const id of [...this.statusSince.keys()]) if (!agents.some((a) => a.id === id)) this.statusSince.delete(id);

    const failing = audit.data?.servicios.filter(serviceHasError).length ?? 0;
    if (failing > 0 && !this.alarmAt) this.alarmAt = now;
    if (failing === 0) this.alarmAt = 0;
    const fetchedAt = audit.fetchedAt ?? now;
    const room: RoomInfo = {
      id: ROOM_ID,
      name: 'n8n',
      path: this.opts.baseUrl || 'n8n',
      slot: 0,
      seed: hash32(ROOM_ID),
      createdAt: this.startedAt,
      effect: failing > 0 ? { kind: 'alarm', text: alarmText(audit.data?.servicios.filter(serviceHasError) ?? []), at: this.alarmAt, until: fetchedAt + ALARM_MS } : undefined,
    };

    const ok = audit.status === 'ok' || audit.status === 'stale';
    return {
      rev: this.rev,
      serverTime: now,
      rooms: agents.length > 0 || audit.status !== 'disabled' ? [room] : [],
      agents,
      accounts: [{ id: ACCOUNT_ID, short: 'n8', name: 'n8n', color: '#ea4b71', configDir: this.opts.baseUrl || 'n8n', sessions: agents.length, usageStatus: 'disabled' }],
      audit,
      meta: {
        demo: this.opts.demo,
        sources: [{ label: 'n8n', path: this.opts.baseUrl || 'n8n', sessions: agents.length, ok, error: audit.error }],
        startedAt: this.startedAt,
        version: this.opts.version,
      },
    };
  }
}
