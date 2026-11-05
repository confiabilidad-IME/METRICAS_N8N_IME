// Contraseñas con scrypt (node:crypto, sin dependencias): solo se guarda un hash con sal propia; la contraseña nunca.
// Formato: scrypt$N$r$p$<sal base64url>$<hash base64url>. Los parámetros viajan en el propio hash, así que se pueden
// endurecer más adelante sin invalidar los usuarios existentes.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;
/** Un hash con costo absurdo (configuración mal escrita o hostil) no debe poder agotar la memoria del servidor. */
const MAX_N = 1 << 20;
const MAX_R = 16;
const MAX_P = 4;

interface Params {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

function derive(plain: string, salt: Buffer, o: Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC: la misma contraseña escrita con otra composición Unicode (ñ, tildes) da el mismo hash.
    scrypt(plain.normalize('NFKC'), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 256 * o.N * o.r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parseHash(stored: string): { params: Params; salt: Buffer; key: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const ok = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;
  // N debe ser potencia de 2 (requisito de scrypt).
  if (!ok(N, MAX_N) || (N & (N - 1)) !== 0 || N < 2 || !ok(r, MAX_R) || !ok(p, MAX_P)) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || key.length < 16) return null;
  return { params: { N, r, p, keylen: key.length }, salt, key };
}

/** ¿La contraseña corresponde al hash? Comparación en tiempo constante; un hash mal formado nunca coincide. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const h = parseHash(stored);
  if (!h) return false;
  const key = await derive(plain, h.salt, h.params);
  return key.length === h.key.length && timingSafeEqual(key, h.key);
}

/** ¿Tiene forma de hash válido? (para validar la configuración al arrancar). */
export function isPasswordHash(stored: string): boolean {
  return parseHash(stored) !== null;
}

let dummy: Promise<string> | undefined;
/**
 * Hash de relleno para el usuario que no existe: así responder "usuario inexistente" tarda lo mismo que "contraseña
 * errónea" y el tiempo de respuesta no revela qué usuarios existen.
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(12).toString('base64url'));
  return dummy;
}
