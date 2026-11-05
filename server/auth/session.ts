// Sesiones sin estado: una cookie con el usuario y su vencimiento, firmada con HMAC-SHA256. Sin base de datos.
// Limitación conocida: no hay revocación individual; "Salir" borra la cookie del navegador, pero un token copiado
// sigue valiendo hasta que venza o hasta que cambie AUDIT_SESSION_SECRET (eso cierra todas las sesiones a la vez).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class Sessions {
  constructor(
    private readonly secret: Buffer,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(user: string): string {
    const payload = Buffer.from(JSON.stringify({ u: user, e: this.now() + this.ttlMs })).toString('base64url');
    return `${payload}.${this.mac(payload)}`;
  }

  /** Usuario de un token válido y no vencido; null si no lo es. */
  verify(token: string | undefined): string | null {
    if (!token || token.length > 512) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const want = Buffer.from(this.mac(payload), 'base64url');
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown };
      return typeof p.u === 'string' && typeof p.e === 'number' && p.e > this.now() ? p.u : null;
    } catch {
      return null;
    }
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }
}

/** Secreto de firma: el de AUDIT_SESSION_SECRET (>= 32 caracteres) o, si falta, uno aleatorio de este arranque. */
export function sessionSecret(env: string | undefined): { secret: Buffer; persistent: boolean } {
  const v = env?.trim();
  if (v && v.length >= 32) return { secret: Buffer.from(v, 'utf8'), persistent: true };
  return { secret: randomBytes(32), persistent: false };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

export function sessionCookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function clearCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
