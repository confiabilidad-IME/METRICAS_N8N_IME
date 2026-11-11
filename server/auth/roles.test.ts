// Rol del usuario: define qué pestañas ve en el modal de Auditoría (gerencia no ve la pestaña Técnico).
import { describe, expect, it } from 'vitest';
import { parseUsers, roleFor } from './users';

describe('roles de usuario', () => {
  it('gerencia queda como gerencia por defecto (aunque se regrabe sin rol); el resto es admin', () => {
    expect(roleFor('gerencia', undefined)).toBe('gerencia');
    expect(roleFor('admin', undefined)).toBe('admin');
    expect(roleFor('maria', 'gerencia')).toBe('gerencia');
    expect(roleFor('gerencia', 'admin')).toBe('admin');
    expect(() => roleFor('x', 'superusuario')).toThrow(/no válido/);
  });
  it('parseUsers informa el rol y rechaza uno inválido', () => {
    expect(() => parseUsers([{ usuario: 'maria', rol: 'jefe', disabled: true }], 'prueba')).toThrow(/maria.*no válido/);
    expect(parseUsers([{ usuario: 'gerencia', disabled: true }], 'prueba')[0].role).toBe('gerencia');
  });
});
