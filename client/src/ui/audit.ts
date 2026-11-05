// "Auditoría": ventana con el estado de los flujos n8n, sus ejecuciones y el efecto en el negocio (cotizaciones definidas,
// pipeline, correos, seguimientos). Los datos llegan en vivo con el snapshot (`snapshot.audit`, rango por defecto); otro
// rango pide GET /api/audit?desde=. Todo se pinta con textContent (los textos vienen de n8n: nunca innerHTML).
// El modelo (formatos, orden, agregaciones) es puro y se prueba en ui/audit-model.test.ts.
import type { AuditAlert, AuditExecutionDay, AuditQuote, AuditReviewQuote, AuditService, AuditSnapshot } from '../../../shared/audit';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import {
  ago,
  auditUrl,
  barHeight,
  count,
  dayShort,
  errorRows,
  execColumns,
  isAuditTab,
  moneyFull,
  moneyShort,
  percent,
  quoteRows,
  RANGES,
  reviewRows,
  serviceRows,
  splitAlerts,
  STATUS_LABEL,
  statusHint,
  TABS,
  tabBadges,
  type AuditTab,
} from './audit-model';

const REFRESH_MS = 60_000;
const TAB_KEY = 'audit.tab';

/** La pestaña elegida se recuerda en el navegador; sin storage (modo privado) el panel funciona igual. */
function loadTab(): AuditTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return isAuditTab(v) ? v : 'tecnico';
  } catch {
    return 'tecnico';
  }
}

function saveTab(tab: AuditTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // sin storage: no se recuerda
  }
}

async function getAudit(url: string): Promise<AuditSnapshot> {
  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as (AuditSnapshot & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `error ${res.status}`);
  return body;
}

/** YYYY-MM-DD de hoy en la zona del navegador (solo para armar el `desde` de un rango). */
function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

export class AuditPanel implements UiComponent {
  readonly el: HTMLDialogElement;
  private rangeIdx = 0;
  /** Datos de un rango propio (consulta puntual); null = usar el snapshot en vivo. */
  private custom: AuditSnapshot | null = null;
  private error: string | null = null;
  private loading = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opener: HTMLElement | null = null;
  private shown: AuditSnapshot | undefined;
  private shownAt = 0;

  private readonly select: HTMLSelectElement;
  private readonly chip: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly content: HTMLElement;
  private tab: AuditTab = loadTab();
  private readonly tabBtns = new Map<AuditTab, { btn: HTMLButtonElement; badge: HTMLElement }>();
  private readonly panels = new Map<AuditTab, HTMLElement>();

  constructor(
    private readonly ctx: UiContext,
    private readonly button: HTMLElement,
  ) {
    this.select = h(
      'select',
      { class: 'ui-day__select', attrs: { 'aria-label': 'Rango de fechas' }, on: { change: () => this.pickRange(Number(this.select.value)) } },
      ...RANGES.map((r, i) => h('option', { text: r.label, attrs: { value: i } })),
    );
    this.chip = h('span', { class: 'ui-audit__chip' });
    this.hint = h('p', { class: 'ui-day__status', attrs: { 'aria-live': 'polite' } });
    this.content = h('div', { class: 'ui-day__content ui-audit__content' });
    const tablist = h('div', { class: 'ui-audit__tabs', role: 'tablist', attrs: { 'aria-label': 'Secciones de la auditoría' } });
    for (const t of TABS) {
      const badge = h('span', { class: 'ui-audit__tab-badge', hidden: true });
      const btn = h(
        'button',
        { class: 'ui-audit__tab', type: 'button', role: 'tab', title: t.hint, attrs: { id: `ui-audit-tab-${t.id}`, 'aria-controls': `ui-audit-panel-${t.id}` }, on: { click: () => this.selectTab(t.id, false) } },
        h('span', { text: t.label }),
        badge,
      );
      tablist.append(btn);
      this.tabBtns.set(t.id, { btn, badge });
      const panel = h('div', { class: 'ui-audit__panel', role: 'tabpanel', attrs: { id: `ui-audit-panel-${t.id}`, 'aria-labelledby': `ui-audit-tab-${t.id}` } });
      this.panels.set(t.id, panel);
      this.content.append(panel);
    }
    tablist.addEventListener('keydown', (e) => this.onTabKey(e));
    const close = iconButton(ICONS.close, 'Cerrar (Esc)', () => this.close(), 'ui-icon-btn--sm');

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-day ui-audit', attrs: { 'aria-labelledby': 'ui-audit-title' } },
      h('div', { class: 'ui-dialog__head ui-day__head' }, h('div', { class: 'ui-day__title' }, h('h2', { text: 'Auditoría n8n', attrs: { id: 'ui-audit-title' } }), this.chip), h('div', { class: 'ui-day__controls' }, this.select), close),
      tablist,
      h('div', { class: 'ui-day__body' }, this.hint, this.content),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    // El teclado queda dentro de la ventana: los atajos del escritorio no deben dispararse por debajo.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => this.onClosed());
    this.applyTab();
  }

  private selectTab(tab: AuditTab, focus: boolean): void {
    this.tab = tab;
    saveTab(tab);
    this.applyTab();
    if (focus) this.tabBtns.get(tab)?.btn.focus();
  }

  private applyTab(): void {
    for (const [id, { btn }] of this.tabBtns) {
      const on = id === this.tab;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      btn.classList.toggle('is-on', on);
      setHidden(this.panels.get(id)!, !on);
    }
  }

  /** Flechas, Inicio y Fin cambian de pestaña (patrón de teclado de las pestañas). */
  private onTabKey(e: KeyboardEvent): void {
    const i = TABS.findIndex((t) => t.id === this.tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    this.selectTab(TABS[next].id, true);
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(): void {
    if (this.el.open) return;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.el.showModal();
    this.button.setAttribute('aria-expanded', 'true');
    this.paint(true);
    if (this.rangeIdx !== 0) void this.loadCustom();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  /** Cada cuadro con cambios: si llegó un snapshot nuevo con auditoría distinta, se repinta. */
  render(): void {
    if (this.el.open) this.paint(false);
  }

  private onClosed(): void {
    this.seq++;
    this.stopTimer();
    this.button.setAttribute('aria-expanded', 'false');
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
  }

  private pickRange(i: number): void {
    this.rangeIdx = Number.isInteger(i) && RANGES[i] ? i : 0;
    this.custom = null;
    this.error = null;
    this.stopTimer();
    this.seq++;
    this.paint(true);
    if (this.rangeIdx !== 0) void this.loadCustom();
  }

  private async loadCustom(): Promise<void> {
    const seq = ++this.seq;
    this.stopTimer();
    this.loading = true;
    this.paint(true);
    try {
      const snap = await getAudit(auditUrl(RANGES[this.rangeIdx].days, todayLocal()));
      if (seq !== this.seq) return;
      this.custom = snap;
      this.error = null;
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.ctx.announce('No se pudo cargar el rango de la auditoría.');
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.paint(true);
        if (this.el.open) this.timer = setTimeout(() => void this.loadCustom(), REFRESH_MS);
      }
    }
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private current(): AuditSnapshot | undefined {
    return this.rangeIdx === 0 ? this.ctx.store.snapshot?.audit : (this.custom ?? undefined);
  }

  private paint(force: boolean): void {
    const audit = this.current();
    const now = this.ctx.now();
    // Los "hace X min" cambian con el reloj: se refrescan como máximo cada 15 s aunque no llegue un snapshot.
    if (!force && audit === this.shown && now - this.shownAt < 15_000) return;
    this.shown = audit;
    this.shownAt = now;

    const status = this.error && !audit ? 'error' : (audit?.status ?? 'pending');
    this.chip.className = `ui-audit__chip is-${status}`;
    setText(this.chip, STATUS_LABEL[status]);
    const hint = this.error ?? (this.loading && !audit ? 'Cargando…' : statusHint(audit));
    const source = audit?.fuenteServicios === 'api' ? 'servicios en vivo (API de n8n)' : audit?.fuenteServicios === 'AUD03' ? `servicios según AUD03${audit.errorApi ? ` — API no disponible: ${audit.errorApi}` : ''}` : '';
    setText(this.hint, audit?.fetchedAt && !hint ? `Actualizado ${ago(new Date(audit.fetchedAt).toISOString(), now)} · se renueva solo${source ? ` · ${source}` : ''}` : hint);
    setHidden(this.hint, !this.hint.textContent);

    if (!audit?.data || !audit.kpis) {
      for (const panel of this.panels.values()) panel.replaceChildren(h('p', { class: 'ui-day__empty', text: 'Aún no hay datos de auditoría para mostrar.' }));
      this.renderBadges(undefined);
      return;
    }
    const alerts = splitAlerts(audit.alertas);
    this.panels.get('tecnico')!.replaceChildren(...this.technical(audit, alerts.tecnico, now));
    this.panels.get('cotizaciones')!.replaceChildren(...this.quotes(audit, alerts.cotizaciones, now));
    this.renderBadges(audit);
  }

  private renderBadges(audit: AuditSnapshot | undefined): void {
    const b = audit?.data && audit.kpis ? tabBadges(audit.data.servicios, audit.alertas, audit.data.cotizaciones_revision?.length ?? audit.kpis.enRevisionManual) : undefined;
    for (const [id, { badge, btn }] of this.tabBtns) {
      const v = b?.[id];
      setHidden(badge, !v || v.level === 'none');
      badge.className = `ui-audit__tab-badge is-${v?.level ?? 'none'}`;
      setText(badge, v ? String(v.count) : '');
      const label = TABS.find((t) => t.id === id)!.label;
      btn.setAttribute('aria-label', v && v.level !== 'none' ? `${label}, ${v.count} ${v.level === 'error' ? 'con error' : 'por revisar'}` : label);
    }
  }

  /** Pestaña Técnico: errores de flujos, estado de servicios y ejecuciones. */
  private technical(audit: AuditSnapshot, alerts: AuditAlert[], now: number): HTMLElement[] {
    const data = audit.data!;
    const k = audit.kpis!;
    const out: HTMLElement[] = [];

    // Lo primero que debe verse: qué flujo falló y por qué.
    const errors = errorRows(data.servicios, now, audit.n8nUrl);
    if (errors.length) out.push(this.section(`Flujos con error (${errors.length})`, this.errorList(errors)));

    out.push(
      this.section(
        'Resumen técnico',
        h(
          'div',
          { class: 'ui-audit__cards' },
          this.card('Servicios activos', `${count(k.serviciosActivos)} de ${count(k.serviciosTotal)}`),
          this.card('Flujos con error', count(k.serviciosConError), k.serviciosConError > 0 ? 'is-lost' : 'is-won'),
          this.card('Ejecuciones en el rango', count(k.ejecucionesTotal)),
          this.card('Ejecuciones con error', count(k.ejecucionesError), k.ejecucionesError > 0 ? 'is-lost' : ''),
        ),
      ),
    );
    if (alerts.length) out.push(this.alertsSection(alerts, undefined, now));
    out.push(this.section(`Servicios (${k.serviciosActivos} activos de ${k.serviciosTotal})`, this.servicesTable(data.servicios, now)));
    out.push(this.section('Ejecuciones por día', this.execChart(data.ejecuciones_diarias, k.ejecucionesTotal, k.ejecucionesError)));
    return out;
  }

  /** Pestaña Cotizaciones: definidas, situación acumulada, revisión manual y últimas definidas. */
  private quotes(audit: AuditSnapshot, alerts: AuditAlert[], now: number): HTMLElement[] {
    const data = audit.data!;
    const k = audit.kpis!;
    const out: HTMLElement[] = [];
    // La alerta de revisión manual lleva dentro las cotizaciones concretas.
    if (alerts.length) out.push(this.alertsSection(alerts, data.cotizaciones_revision, now));
    out.push(
      this.section(
        'Cotizaciones definidas en el rango',
        h(
          'div',
          { class: 'ui-audit__cards' },
          this.card('Definidas', count(k.definidasPeriodo)),
          this.card('Ganadas', count(k.ganadasPeriodo), 'is-won'),
          this.card('Perdidas', count(k.perdidasPeriodo), 'is-lost'),
          this.card('Tasa de cierre', percent(k.tasaCierrePeriodo)),
          this.card('Valor ganado', moneyShort(k.valorGanadoPeriodo), 'is-won', moneyFull(k.valorGanadoPeriodo)),
          this.card('Valor perdido', moneyShort(k.valorPerdidoPeriodo), 'is-lost', moneyFull(k.valorPerdidoPeriodo)),
        ),
      ),
      this.section(
        k.fotoFecha ? `Situación acumulada al ${dayShort(k.fotoFecha)}` : 'Situación acumulada',
        h(
          'div',
          { class: 'ui-audit__cards' },
          this.card('Pipeline', moneyShort(k.valorPipeline), '', moneyFull(k.valorPipeline)),
          this.card('Cotizaciones activas', count(k.cotizacionesActivas)),
          this.card('En revisión manual', count(data.cotizaciones_revision?.length ?? k.enRevisionManual), (data.cotizaciones_revision?.length ?? k.enRevisionManual) > 0 ? 'is-warn' : ''),
          this.card('Tasa de cierre', percent(k.tasaCierreAcum)),
          this.card('Ganadas / perdidas', `${count(k.ganadasAcum)} / ${count(k.perdidasAcum)}`),
        ),
      ),
      this.section('Últimas cotizaciones definidas', this.quotesTable(data.cotizaciones_definidas)),
    );
    return out;
  }

  /** Alertas; la de revisión manual despliega debajo las cotizaciones concretas (si AUD04 las informa). */
  private alertsSection(alerts: AuditAlert[], review: readonly AuditReviewQuote[] | undefined, now: number): HTMLElement {
    return this.section(
      `Alertas (${alerts.length})`,
      h(
        'ul',
        { class: 'ui-audit__alerts' },
        ...alerts.map((a) => {
          const detail = a.id.startsWith('revision-manual:') && review?.length ? this.reviewTable(review, now) : null;
          return h('li', { class: `ui-audit__alert is-${a.level}` }, h('span', { text: a.text }), detail);
        }),
      ),
    );
  }

  private reviewTable(list: readonly AuditReviewQuote[], now: number): HTMLElement {
    const rows = reviewRows(list, now);
    return h(
      'table',
      { class: 'ui-audit__table ui-audit__review' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Cotización' }), h('th', { text: 'Cliente' }), h('th', { text: 'Comercial' }), h('th', { text: 'Estado' }), h('th', { text: 'Próxima acción' }), h('th', { class: 'is-num', text: 'Valor' }), h('th', { text: 'Sin moverse' }))),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {},
            h('td', { text: r.number }),
            h('td', { text: r.client, title: r.objection ? `Objeción: ${r.objection}` : undefined }),
            h('td', { text: r.owner }),
            h('td', { text: r.state }),
            h('td', { text: r.action }),
            h('td', { class: 'is-num', text: r.value > 0 ? moneyShort(r.value) : '—', title: r.value > 0 ? moneyFull(r.value) : undefined }),
            h('td', { text: r.since }),
          ),
        ),
      ),
    );
  }

  private errorList(rows: ReturnType<typeof errorRows>): HTMLElement {
    const link = (href: string | undefined, text: string): HTMLElement | null =>
      href ? h('a', { class: 'ui-audit__link', text, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }) : null;
    return h(
      'ul',
      { class: 'ui-audit__errors' },
      ...rows.map((r) =>
        h(
          'li',
          { class: 'ui-audit__error' },
          h('div', { class: 'ui-audit__error-head' }, h('strong', { text: r.name }), h('span', { class: 'ui-audit__error-when', text: r.when })),
          r.node ? h('p', { class: 'ui-audit__error-line', text: `Nodo: ${r.node}` }) : null,
          r.message ? h('p', { class: 'ui-audit__error-line ui-audit__error-msg', text: r.message }) : null,
          !r.node && !r.message ? h('p', { class: 'ui-audit__error-line', text: 'n8n no informó el detalle de la ejecución fallida.' }) : null,
          h('div', { class: 'ui-audit__error-links' }, link(r.execUrl, 'Ver la ejecución en n8n'), link(r.flowUrl, 'Abrir el flujo')),
        ),
      ),
    );
  }

  private section(title: string, body: HTMLElement): HTMLElement {
    return h('section', { class: 'ui-day__card ui-audit__section' }, h('h3', { text: title }), body);
  }

  private card(label: string, value: string, variant = '', title?: string): HTMLElement {
    return h('div', { class: `ui-audit__stat ${variant}`.trim(), title }, h('span', { class: 'ui-audit__value', text: value }), h('span', { class: 'ui-audit__label', text: label }));
  }

  private servicesTable(services: readonly AuditService[], now: number): HTMLElement {
    const rows = serviceRows(services, now);
    if (!rows.length) return h('p', { class: 'ui-day__empty', text: 'Audit_Servicios está vacío: AUD03 aún no ha escrito datos.' });
    return h(
      'table',
      { class: 'ui-audit__table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Flujo' }), h('th', { text: 'Estado' }), h('th', { text: 'Última ejecución' }), h('th', { class: 'is-num', text: 'Errores 24 h' }))),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            { class: r.state === 'inactive' ? 'is-dim' : '' },
            h('td', { text: r.name }),
            h('td', {}, h('span', { class: `ui-audit__pill is-${r.state}`, text: r.label })),
            h('td', { text: r.last }),
            h('td', { class: 'is-num', text: count(r.errors24h) }),
          ),
        ),
      ),
    );
  }

  private execChart(rows: readonly AuditExecutionDay[], total: number, errors: number): HTMLElement {
    const cols = execColumns(rows);
    if (!cols.length) return h('p', { class: 'ui-day__empty', text: 'Sin ejecuciones registradas en el rango.' });
    const max = Math.max(...cols.map((c) => c.total));
    const bars = cols.map((c) => {
      const okH = barHeight(c.ok, max);
      const errH = barHeight(c.errors, max);
      return h(
        'div',
        { class: 'ui-audit__col', title: `${dayShort(c.day)}: ${count(c.total)} ejecuciones, ${count(c.errors)} con error`, tabIndex: 0, attrs: { 'aria-label': `${dayShort(c.day)}: ${c.total} ejecuciones, ${c.errors} con error` } },
        h('div', { class: 'ui-audit__bar' }, h('span', { class: 'is-err', style: `height:${errH}%` }), h('span', { class: 'is-ok', style: `height:${okH}%` })),
        h('span', { class: 'ui-audit__tick', text: dayShort(c.day) }),
      );
    });
    return h('div', {}, h('div', { class: 'ui-audit__chart', role: 'group', attrs: { 'aria-label': 'Ejecuciones por día' } }, ...bars), h('p', { class: 'ui-day__note', text: `${count(total)} ejecuciones en el rango, ${count(errors)} con error.` }));
  }

  private quotesTable(quotes: readonly AuditQuote[]): HTMLElement {
    const rows = quoteRows(quotes);
    if (!rows.length) return h('p', { class: 'ui-day__empty', text: 'No hay cotizaciones definidas en el rango.' });
    return h(
      'table',
      { class: 'ui-audit__table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Cotización' }), h('th', { text: 'Cliente' }), h('th', { text: 'Comercial' }), h('th', { text: 'Resultado' }), h('th', { class: 'is-num', text: 'Valor' }), h('th', { text: 'Fecha' }))),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {},
            h('td', { text: r.number }),
            h('td', { text: r.client }),
            h('td', { text: r.owner }),
            h('td', {}, h('span', { class: `ui-audit__pill ${r.won ? 'is-ok' : 'is-error'}`, text: r.won ? 'Ganada' : 'Perdida', title: r.detail || undefined })),
            h('td', { class: 'is-num', text: moneyShort(r.value), title: moneyFull(r.value) }),
            h('td', { text: r.day ? dayShort(r.day) : '—' }),
          ),
        ),
      ),
    );
  }
}
