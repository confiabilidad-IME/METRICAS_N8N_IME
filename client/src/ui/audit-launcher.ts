// Botón "Auditoría" de la barra superior. El panel (ui/audit.ts) se descarga en la primera apertura, como "Meu dia".
import type { AuditPanel } from './audit';
import type { UiComponent, UiContext } from './context';
import { iconButton } from './dom';

/** Un tablero con un pulso (el mismo trazo en píxeles de los otros íconos de la barra). */
const AUDIT_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M0 1h10v1H0zM0 8h10v1H0zM0 1h1v8H0zM9 1h1v8H9zM2 6h1v1H2zM3 5h1v1H3zM4 3h1v2H4zM5 5h1v1H5zM6 6h2v1H6z"/></svg>';

export class AuditLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  private panel: AuditPanel | null = null;
  private loading: Promise<AuditPanel> | null = null;

  /** `mount` coloca la ventana del panel en la interfaz cuando se crea. */
  constructor(
    private readonly ctx: UiContext,
    private readonly mount: (el: HTMLElement) => void,
  ) {
    this.button = iconButton(AUDIT_ICON, 'Auditoría n8n: servicios, ejecuciones y métricas (M)', () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
  }

  toggle(): void {
    if (this.panel) this.panel.toggle();
    else
      void this.load()
        .then((p) => p.open())
        .catch(() => this.ctx.announce('No se pudo abrir el panel de auditoría.'));
  }

  render(): void {
    this.panel?.render();
  }

  private load(): Promise<AuditPanel> {
    this.loading ??= import('./audit').then((m) => {
      const panel = new m.AuditPanel(this.ctx, this.button);
      this.mount(panel.el);
      this.panel = panel;
      return panel;
    });
    // Falló la descarga: el próximo intento vuelve a pedirla.
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }
}
