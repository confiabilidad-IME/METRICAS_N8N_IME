// Sondeo periódico de n8n. Métricas de negocio: AUD04. Servicios y ejecuciones de hoy: API pública de n8n en vivo (si hay
// N8N_API_KEY); si falla, lo que dejó AUD03. Guarda el último dato bueno; si una consulta falla, el estado pasa a `stale`
// (con datos) o `error` (sin datos) y el sondeo sigue: n8n caído un rato no debe tumbar el tablero.
import type { AuditData, AuditSnapshot } from '../../shared/audit';
import { errMsg, log } from '../log';
import { AuditFetchError, fetchAudit } from './client';
import type { AuditConfig } from './config';
import { demoAudit } from './demo';
import { addDays, computeKpis, dayIn, deriveAlerts } from './derive';
import { fetchLive, mergeLive, type ErrorCache, type LastSeenCache } from './live';

export interface PollerDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Loaded {
  data: AuditData;
  fuente?: AuditSnapshot['fuenteServicios'];
  errorApi?: string;
}

export class AuditPoller {
  private snap: AuditSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private readonly lastSeen: LastSeenCache = new Map();
  private readonly errors: ErrorCache = new Map();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  /** `cfg` null = sin configuración (falta N8N_BASE_URL o N8N_AUDIT_TOKEN): el estado queda `disabled` y no se consulta nada. */
  constructor(
    private readonly cfg: AuditConfig | null,
    deps: PollerDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.snap = { status: cfg ? 'pending' : 'disabled', desde: this.defaultFrom(), alertas: [] };
  }

  /** Primer día de la consulta por defecto (hoy menos `rangeDays`, en APP_TIMEZONE). */
  defaultFrom(): string {
    return addDays(dayIn(this.cfg?.timezone ?? 'America/Bogota', this.now()), -(this.cfg?.rangeDays ?? 30));
  }

  snapshot(): AuditSnapshot {
    return this.snap;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  start(): void {
    if (this.timer || !this.cfg) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Consulta ahora. Varias llamadas simultáneas comparten la misma consulta. */
  refresh(): Promise<void> {
    if (!this.cfg) return Promise.resolve();
    this.inflight ??= this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Consulta puntual con otro rango (GET /api/audit?desde=&hasta=): no toca el snapshot del sondeo. */
  async query(range: { desde?: string; hasta?: string }): Promise<AuditSnapshot> {
    const desde = range.desde ?? this.defaultFrom();
    return this.build(await this.load({ desde, hasta: range.hasta }), desde, range.hasta, []);
  }

  private async load(range: { desde?: string; hasta?: string }): Promise<Loaded> {
    const cfg = this.cfg;
    if (!cfg) throw new AuditFetchError('auditoría sin configurar (N8N_BASE_URL / N8N_AUDIT_TOKEN)');
    if (cfg.demo) return { data: demoAudit(this.now(), cfg.timezone, range.desde), fuente: 'api' };
    const data = await fetchAudit(cfg, range, this.fetchImpl);
    if (!cfg.apiKey) return { data, fuente: 'AUD03' };
    try {
      const live = await fetchLive({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, projectId: cfg.projectId, timezone: cfg.timezone, requestTimeoutMs: cfg.requestTimeoutMs }, this.now(), this.fetchImpl, this.lastSeen, this.errors);
      log.clearOnce('live');
      return { data: mergeLive(data, live, dayIn(cfg.timezone, this.now())), fuente: 'api' };
    } catch (e) {
      const errorApi = e instanceof AuditFetchError ? e.message : 'error inesperado en la API de n8n';
      log.warnOnce('live', `API de n8n no disponible, se usan los datos de AUD03: ${errorApi}`);
      return { data, fuente: 'AUD03', errorApi };
    }
  }

  private build(l: Loaded, desde: string, hasta: string | undefined, prev: AuditSnapshot['alertas']): AuditSnapshot {
    const now = this.now();
    return { status: 'ok', fetchedAt: now, desde, hasta, data: l.data, kpis: computeKpis(l.data), alertas: deriveAlerts(l.data, now, prev), fuenteServicios: l.fuente, errorApi: l.errorApi, n8nUrl: this.cfg?.baseUrl || undefined };
  }

  private async run(): Promise<void> {
    const desde = this.defaultFrom();
    try {
      this.snap = this.build(await this.load({ desde }), desde, undefined, this.snap.alertas);
    } catch (e) {
      const error = e instanceof AuditFetchError ? e.message : 'error inesperado consultando n8n';
      if (!(e instanceof AuditFetchError)) log.warn(`auditoría: ${errMsg(e)}`);
      // Con datos previos se conservan (stale).
      this.snap = { ...this.snap, status: this.snap.data ? 'stale' : 'error', error, desde };
    }
    for (const cb of this.listeners) cb();
  }
}
