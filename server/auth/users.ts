// Usuarios del tablero. Se combinan, de menor a mayor prioridad:
//   1. users.default.json  (en el repositorio: los usuarios por defecto, solo con hashes)
//   2. users.json          (local, ignorado por git: lo escribe `npm run user:add`; permite cambiar una contraseña)
//   3. AUDIT_USERS         (variable de entorno con un JSON: para hostings sin disco persistente)
// Un usuario con "disabled": true en una capa posterior desactiva al de las anteriores. Nunca hay contraseñas en claro.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditRole } from '../../shared/audit';
import { isPasswordHash } from './passwords';

export interface AuthUser {
  /** Nombre en minúsculas: el inicio de sesión no distingue mayúsculas. */
  name: string;
  hash: string;
  /** Qué puede ver. Ausente se trata como `admin` (solo en pruebas): `parseUsers` siempre lo informa. */
  role?: AuditRole;
}

interface RawUser {
  usuario?: unknown;
  hash?: unknown;
  disabled?: unknown;
  rol?: unknown;
}

const ROLES: readonly AuditRole[] = ['admin', 'gerencia'];

/**
 * Rol de un usuario: el campo "rol" si está; si no, "gerencia" para el usuario llamado gerencia (así sigue restringido
 * aunque `npm run user:add` le cambie la contraseña y regrabe el registro sin rol) y "admin" para el resto.
 */
export function roleFor(name: string, rol: unknown): AuditRole {
  if (rol === undefined || rol === null || rol === '') return name === 'gerencia' ? 'gerencia' : 'admin';
  if (typeof rol === 'string' && (ROLES as readonly string[]).includes(rol)) return rol as AuditRole;
  throw new Error(`rol "${String(rol)}" no válido (usa ${ROLES.join(' o ')})`);
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function normalizeUsername(v: string): string {
  return v.trim().toLowerCase();
}

/** Valida y normaliza una lista; lanza con el motivo si algo no es válido (mejor no arrancar que arrancar sin login). */
export function parseUsers(raw: unknown, origin: string): Array<AuthUser & { disabled: boolean }> {
  if (!Array.isArray(raw)) throw new Error(`${origin}: se esperaba una lista de usuarios`);
  return raw.map((u: RawUser, i) => {
    const name = typeof u?.usuario === 'string' ? normalizeUsername(u.usuario) : '';
    if (!USERNAME_RE.test(name)) throw new Error(`${origin}: usuario #${i + 1} con nombre inválido (2-32 caracteres: letras, números, . _ -)`);
    const disabled = u.disabled === true;
    const hash = typeof u.hash === 'string' ? u.hash : '';
    if (!disabled && !isPasswordHash(hash)) throw new Error(`${origin}: el usuario "${name}" no tiene un hash scrypt válido (genera uno con npm run user:hash)`);
    let role: AuditRole;
    try {
      role = roleFor(name, u.rol);
    } catch (e) {
      throw new Error(`${origin}: usuario "${name}": ${(e as Error).message}`);
    }
    return { name, hash, disabled, role };
  });
}

function readJson(path: string, origin: string, optional: boolean): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${origin}: no se pudo leer (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${origin}: JSON inválido`);
  }
}

/** Carga y combina las tres capas. Devuelve solo los usuarios activos. */
export function loadUsers(env: Record<string, string | undefined>, rootDir: string): AuthUser[] {
  const layers: Array<Array<AuthUser & { disabled: boolean }>> = [];
  const defaults = readJson(join(rootDir, 'users.default.json'), 'users.default.json', true);
  if (defaults !== undefined) layers.push(parseUsers(defaults, 'users.default.json'));
  const file = env.AUDIT_USERS_FILE?.trim() || join(rootDir, 'users.json');
  const local = readJson(file, 'users.json', true);
  if (local !== undefined) layers.push(parseUsers(local, 'users.json'));
  if (env.AUDIT_USERS?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.AUDIT_USERS);
    } catch {
      throw new Error('AUDIT_USERS: JSON inválido');
    }
    layers.push(parseUsers(parsed, 'AUDIT_USERS'));
  }
  const merged = new Map<string, AuthUser & { disabled: boolean }>();
  for (const layer of layers) for (const u of layer) merged.set(u.name, u);
  return [...merged.values()].filter((u) => !u.disabled).map(({ name, hash, role }) => ({ name, hash, role }));
}
