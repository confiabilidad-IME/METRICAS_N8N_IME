// Ayuda ("?"): cómo leer el tablero de auditoría de n8n (personajes, alarma de la sala, panel) y los atajos.
import type { AgentStatus } from '../../../shared/types';
import type { HelpSection } from './context';
import { h, iconButton } from './dom';
import { ICONS } from './icons';
import { STATUS_LABEL } from './model';

const INTRO =
  'Cada flujo de n8n activo es un personaje de la sala “n8n”. Lo que hace el personaje refleja el estado real del flujo, ' +
  'que se consulta a n8n cada minuto. Los flujos inactivos no aparecen en la oficina, pero sí en el panel Auditoría.';

const STATUS_HELP: [AgentStatus, string][] = [
  ['working', 'Se ejecutó en los últimos 5 minutos: está en su mesa trabajando.'],
  ['waiting', 'Mano levantada: su última ejecución falló y necesita revisión.'],
  ['idle', 'Activo y sin ejecuciones recientes: circula por la oficina hasta la próxima ejecución.'],
];

const ROOM_HELP: [string, string][] = [
  ['🚨', 'Alarma en la sala: al menos un flujo activo tiene la última ejecución fallida o errores en las últimas 24 horas.'],
  ['⚙️', 'En el feed aparece cada ejecución nueva de un flujo.'],
  ['⚠️', 'Una ejecución con error se marca en el feed y en los detalles del personaje.'],
];

const PANEL_HELP: [string, string][] = [
  ['Técnico', 'Flujos con error (nodo, mensaje y enlace a n8n), servicios activos y ejecuciones por día. La insignia roja cuenta los flujos que fallan.'],
  ['Cotizaciones', 'Definidas en el rango (ganadas y perdidas), situación acumulada (pipeline, activas; no se suma entre días) y las que están en revisión manual, con cliente, comercial y cuánto llevan sin moverse.'],
];

const SHORTCUTS: [string[], string][] = [
  [['M'], 'Abrir o cerrar el panel Auditoría (métricas)'],
  [['/'], 'Buscar un flujo'],
  [['F'], 'Seguir al personaje seleccionado'],
  [['O', '0'], 'Visión general del edificio'],
  [['Esc'], 'Cerrar la ventana abierta; después, el detalle y la selección'],
  [['['], 'Mostrar u ocultar el panel lateral'],
  [[']'], 'Mostrar u ocultar el feed de actividad'],
  [['?'], 'Abrir esta ayuda'],
  [['←', '↑', '→', '↓'], 'Mover la cámara (también W A S D)'],
  [['+', '−'], 'Acercar y alejar'],
];

function keys(list: string[]): HTMLElement {
  return h('span', { class: 'ui-keys' }, ...list.map((k) => h('kbd', { class: 'ui-kbd', text: k })));
}

export class HelpDialog {
  readonly el: HTMLDialogElement;

  constructor() {
    const close = iconButton(ICONS.close, 'Cerrar ayuda', () => this.el.close(), 'ui-icon-btn--sm');
    const statusList = h(
      'ul',
      { class: 'ui-legend' },
      ...STATUS_HELP.map(([s, text]) => h('li', {}, h('span', { class: `ui-status-dot is-${s}`, attrs: { 'aria-hidden': 'true' } }), h('strong', { text: STATUS_LABEL[s] }), h('span', { text }))),
    );
    const roomList = h(
      'ul',
      { class: 'ui-icon-legend' },
      ...ROOM_HELP.map(([icon, text]) => h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: icon, attrs: { 'aria-hidden': 'true' } }), h('span', { text }))),
    );
    const panelList = h('ul', { class: 'ui-help__list' }, ...PANEL_HELP.map(([name, text]) => h('li', {}, h('strong', { text: `${name}: ` }), text)));
    const shortcuts = h('dl', { class: 'ui-shortcuts' }, ...SHORTCUTS.flatMap(([k, text]) => [h('dt', {}, keys(k)), h('dd', { text })]));

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-help', attrs: { 'aria-labelledby': 'ui-help-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: 'Cómo leer el tablero', attrs: { id: 'ui-help-title' } }), close),
      h(
        'div',
        { class: 'ui-dialog__body' },
        h('section', { class: 'ui-help__intro' }, h('p', { text: INTRO })),
        h('section', {}, h('h3', { text: 'Estado de los flujos' }), statusList),
        h('section', {}, h('h3', { text: 'La sala y el feed' }), roomList),
        h('section', {}, h('h3', { text: 'Panel Auditoría' }), panelList),
        h('section', {}, h('h3', { text: 'Atajos de teclado' }), shortcuts),
      ),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  /** `section` se conserva por compatibilidad con UiContext.openHelp; esta ayuda no tiene secciones enlazables. */
  open(_section?: HelpSection): void {
    if (!this.el.open) this.el.showModal();
  }

  get isOpen(): boolean {
    return this.el.open;
  }
}
