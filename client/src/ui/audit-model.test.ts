import { describe, expect, it } from 'vitest';
import type { AuditService } from '../../../shared/audit';
import { ago, auditUrl, barHeight, dayShort, errorRows, execColumns, isAuditTab, latestCartera, moneyShort, moraBuckets, percent, prettyLabel, quoteRows, reviewRows, serviceRows, splitAlerts, statusHint, TABS, tabBadges, visibleTabs } from './audit-model';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const svc = (id: string, over: Partial<AuditService> = {}): AuditService => ({ workflow_id: id, workflow_nombre: `Flujo ${id}`, activo: true, errores_24h: 0, ...over });

describe('formatos', () => {
  it('moneyShort compacta en millones', () => {
    expect(moneyShort(84_767_579)).toMatch(/^\$ 84,8\s?M$/);
    expect(moneyShort(0)).toBe('$ 0');
  });
  it('percent con coma decimal y null como guion', () => {
    expect(percent(0.9091)).toBe('90,9 %');
    expect(percent(0)).toBe('0,0 %');
    expect(percent(null)).toBe('—');
  });
  it('ago en escalas y casos inválidos', () => {
    expect(ago(new Date(NOW - 10_000).toISOString(), NOW)).toBe('hace instantes');
    expect(ago(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('hace 5 min');
    expect(ago(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('hace 3 h');
    expect(ago(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('hace 2 d');
    expect(ago(undefined, NOW)).toBe('nunca');
    expect(ago('basura', NOW)).toBe('nunca');
    // un reloj del servidor adelantado no produce tiempos negativos
    expect(ago(new Date(NOW + 60_000).toISOString(), NOW)).toBe('hace instantes');
  });
  it('dayShort no se corre un día por la zona horaria', () => {
    expect(dayShort('2026-11-01')).toBe('1 nov');
    expect(dayShort('2026-12-31')).toBe('31 dic');
    expect(dayShort('x')).toBe('x');
  });
});

describe('serviceRows', () => {
  it('ordena: fallidos, con errores, sanos, inactivos', () => {
    const rows = serviceRows(
      [svc('d', { activo: false }), svc('c'), svc('b', { errores_24h: 2 }), svc('a', { estado_ultima: 'error' })],
      NOW,
    );
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['a', 'error'],
      ['b', 'warn'],
      ['c', 'ok'],
      ['d', 'inactive'],
    ]);
  });
  it('un flujo inactivo no se marca como fallido aunque su última ejecución lo fuera', () => {
    expect(serviceRows([svc('a', { activo: false, estado_ultima: 'error', errores_24h: 5 })], NOW)[0].state).toBe('inactive');
  });
});

describe('execColumns', () => {
  it('suma los flujos de cada día y ordena por fecha', () => {
    const row = (fecha: string, total: number, errores: number) => ({ workflow_id: 'x', workflow_nombre: 'x', fecha, total, exitosas: total - errores, errores, duracion_prom_seg: 1 });
    const cols = execColumns([row('2026-11-02', 10, 1), row('2026-11-01', 4, 0), row('2026-11-02', 6, 2)]);
    expect(cols).toEqual([
      { day: '2026-11-01', total: 4, errors: 0, ok: 4 },
      { day: '2026-11-02', total: 16, errors: 3, ok: 13 },
    ]);
  });
});

describe('quoteRows', () => {
  it('las más recientes primero, con OC o motivo de pérdida', () => {
    const rows = quoteRows([
      { cotizacion_id: 'a', resultado_final: 'PERDIDA', valor: 1, motivo_perdida: 'Precio', fecha_definicion: '2026-11-01T10:00:00Z' },
      { cotizacion_id: 'b', resultado_final: 'GANADA', valor: 2, numero_oc: '77', fecha_definicion: '2026-11-03T10:00:00Z' },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[0]).toMatchObject({ won: true, detail: 'OC 77', day: '2026-11-03' });
    expect(rows[1]).toMatchObject({ won: false, detail: 'Precio' });
  });
  it('respeta el límite y tolera campos ausentes', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ cotizacion_id: `c${i}`, resultado_final: 'GANADA' as const, valor: 0 }));
    const rows = quoteRows(many, 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ client: '—', owner: '—', detail: '' });
  });
});

describe('auditUrl', () => {
  it('sin días usa el snapshot en vivo; con días arma desde= en YYYY-MM-DD', () => {
    expect(auditUrl(null, '2026-11-04')).toBe('/api/audit');
    expect(auditUrl(7, '2026-11-04')).toBe('/api/audit?desde=2026-10-28');
    expect(auditUrl(90, '2026-11-04')).toBe('/api/audit?desde=2026-08-06');
  });
});

describe('barHeight', () => {
  it('proporcional, con mínimo visible y 0 para cero', () => {
    expect(barHeight(50, 100)).toBe(50);
    expect(barHeight(1, 1000)).toBe(4);
    expect(barHeight(0, 100)).toBe(0);
    expect(barHeight(5, 0)).toBe(0);
  });
});

describe('statusHint', () => {
  it('explica qué falta según el estado', () => {
    expect(statusHint(undefined)).toMatch(/Esperando/);
    expect(statusHint({ status: 'disabled', desde: '', alertas: [] })).toMatch(/N8N_AUDIT_TOKEN/);
    expect(statusHint({ status: 'stale', desde: '', alertas: [], error: 'n8n respondió 500' })).toBe('n8n respondió 500');
    expect(statusHint({ status: 'ok', desde: '', alertas: [] })).toBe('');
  });
});

describe('errorRows', () => {
  const failing = (over: Partial<AuditService> = {}): AuditService => ({ workflow_id: 'w1', workflow_nombre: 'AUD03 - Auditoria', activo: true, errores_24h: 2, estado_ultima: 'error', ...over });
  const err = { execution_id: '99', at: new Date(NOW - 20 * 60_000).toISOString(), nodo: 'Listar workflows', mensaje: 'Request failed with status code 404' };

  it('lista solo flujos activos con error, con nodo, mensaje y enlaces a n8n', () => {
    const rows = errorRows([failing({ ultimo_error: err }), svc('ok'), failing({ workflow_id: 'w2', activo: false })], NOW, 'https://n8n.test/');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'w1', when: 'falló hace 20 min', node: 'Listar workflows', message: 'Request failed with status code 404' });
    expect(rows[0].flowUrl).toBe('https://n8n.test/workflow/w1');
    expect(rows[0].execUrl).toBe('https://n8n.test/workflow/w1/executions/99');
  });
  it('sin detalle de la ejecución cae al conteo de 24 h y sin enlace a la ejecución', () => {
    const [r] = errorRows([failing()], NOW, 'https://n8n.test');
    expect(r.when).toBe('2 error(es) en 24 h');
    expect(r.execUrl).toBeUndefined();
  });
  it('no genera enlaces con esquemas que no sean http(s)', () => {
    expect(errorRows([failing({ ultimo_error: err })], NOW, 'javascript:alert(1)')[0].flowUrl).toBeUndefined();
    expect(errorRows([failing({ ultimo_error: err })], NOW, undefined)[0].execUrl).toBeUndefined();
  });
  it('ordena el error más reciente primero', () => {
    const old = { ...err, at: new Date(NOW - 5 * 3600_000).toISOString() };
    const rows = errorRows([failing({ workflow_id: 'viejo', ultimo_error: old }), failing({ workflow_id: 'nuevo', ultimo_error: err })], NOW);
    expect(rows.map((r) => r.id)).toEqual(['nuevo', 'viejo']);
  });
});

describe('pestañas', () => {
  it('cada pestaña se titula por su tema', () => {
    expect(TABS.map((x) => x.label)).toEqual(['Técnico', 'Cotizaciones', 'Facturación']);
  });
  it('reparte las alertas: revisión manual es de cotizaciones, lo demás técnico', () => {
    const r = splitAlerts([{ id: 'ultima-fallida:a' }, { id: 'revision-manual:global' }, { id: 'servicios-vacio:global' }]);
    expect(r.tecnico.map((a) => a.id)).toEqual(['ultima-fallida:a', 'servicios-vacio:global']);
    expect(r.cotizaciones.map((a) => a.id)).toEqual(['revision-manual:global']);
  });
  it('insignias: flujos con error > alertas técnicas > nada; cotizaciones cuenta la revisión manual', () => {
    const bad = svc('a', { estado_ultima: 'error' });
    const none = { count: 0, level: 'none' };
    expect(tabBadges([bad, svc('b')], [], 0)).toEqual({ tecnico: { count: 1, level: 'error' }, cotizaciones: none, facturacion: none });
    expect(tabBadges([svc('b')], [{ id: 'servicios-vacio:global' }], 5)).toEqual({ tecnico: { count: 1, level: 'warn' }, cotizaciones: { count: 5, level: 'warn' }, facturacion: none });
    expect(tabBadges([], [], 0).tecnico.level).toBe('none');
  });
  it('visibleTabs: gerencia (o un rol desconocido) no ve la pestaña técnica', () => {
    expect(visibleTabs('admin').map((t) => t.id)).toEqual(['tecnico', 'cotizaciones', 'facturacion']);
    expect(visibleTabs('gerencia').map((t) => t.id)).toEqual(['cotizaciones', 'facturacion']);
    expect(visibleTabs(undefined).some((t) => t.id === 'tecnico')).toBe(false);
  });
  it('facturación: la insignia cuenta acuerdos de pago vencidos sin pago', () => {
    expect(tabBadges([], [], 0, 2).facturacion).toEqual({ count: 2, level: 'warn' });
    expect(tabBadges([], [], 0).facturacion.level).toBe('none');
  });
  it('latestCartera toma la última fila; moraBuckets reparte la vencida', () => {
    expect(latestCartera([{ fecha: '2026-11-10' }, { fecha: '2026-11-11' }])?.fecha).toBe('2026-11-11');
    expect(latestCartera(undefined)).toBeUndefined();
    const b = moraBuckets({ cartera_vencida: 100, mora_1_30: 50, mora_31_50: 25, mora_51_90: 15, mora_91_mas: 10 });
    expect(b.map((x) => x.share)).toEqual([0.5, 0.25, 0.15, 0.1]);
    expect(moraBuckets({ cartera_vencida: 0, mora_1_30: 0, mora_31_50: 0, mora_51_90: 0, mora_91_mas: 0 }).every((x) => x.share === 0)).toBe(true);
  });
  it('isAuditTab valida lo que viene de localStorage (incluida la pestaña antigua "negocio")', () => {
    expect(isAuditTab('cotizaciones')).toBe(true);
    expect(isAuditTab('negocio')).toBe(false);
    expect(isAuditTab(null)).toBe(false);
  });
});

describe('prettyLabel', () => {
  it('legible a partir del código de n8n', () => {
    expect(prettyLabel('PENDIENTE_RESPUESTA_CLIENTE')).toBe('Pendiente respuesta cliente');
    expect(prettyLabel('REVISION_MANUAL')).toBe('Revisión manual');
    expect(prettyLabel(undefined)).toBe('—');
    expect(prettyLabel('  ')).toBe('—');
  });
});

describe('reviewRows', () => {
  const q = (id: string, over = {}) => ({ cotizacion_id: id, valor: 100, requiere_revision: true, ...over });
  it('muestra número o "Sin número", y ordena primero la que más tiempo lleva sin moverse', () => {
    const rows = reviewRows(
      [
        q('REV-1', { cliente: 'SKF', fecha_ultimo_movimiento: new Date(NOW - 2 * 86_400_000).toISOString() }),
        q('COT-9', { numero_cotizacion: '9', cliente: 'Argos', comercial: 'Julián', estado_actual: 'REVISION_MANUAL', proxima_accion: 'REVISION_HUMANA', fecha_ultimo_movimiento: new Date(NOW - 33 * 86_400_000).toISOString() }),
        q('COT-X', {}),
      ],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(['COT-9', 'REV-1', 'COT-X']);
    expect(rows[0]).toMatchObject({ number: '9', client: 'Argos', owner: 'Julián', state: 'Revisión manual', action: 'Revisión humana', since: 'hace 33 d' });
    expect(rows[1]).toMatchObject({ number: 'Sin número', owner: '—' });
    expect(rows[2].since).toBe('—');
  });
});
