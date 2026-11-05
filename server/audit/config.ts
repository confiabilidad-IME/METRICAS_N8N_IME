// Configuración de la auditoría: variables de entorno (y un .env opcional, sin dependencias externas).
// El token y la API key nunca salen del servidor: no se incluyen en snapshots, logs ni respuestas HTTP.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AuditConfig {
  /** URL base de n8n, sin barra final. */
  baseUrl: string;
  /** Ruta del webhook de AUD04, con barra inicial. */
  webhookPath: string;
  /** Valor de Audit_Config.api_token (header x-audit-token). */
  token: string;
  /** N8N_API_KEY: con ella, servicios y ejecuciones de hoy salen en vivo de la API pública de n8n. */
  apiKey?: string;
  /** N8N_PROJECT_ID: limita los workflows al proyecto (Confiabilidad IME). */
  projectId?: string;
  timezone: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  /** Días hacia atrás de la consulta por defecto. */
  rangeDays: number;
  port: number;
  demo: boolean;
}

/** Parser mínimo de .env: KEY=valor, # comentarios, comillas simples o dobles opcionales. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(val);
    if (quoted) val = quoted[2];
    else val = val.replace(/\s+#.*$/, '');
    out[key] = val;
  }
  return out;
}

/** Lee `.env` (o AUDIT_ENV_FILE); la variable de entorno real gana sobre el archivo. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Record<string, string | undefined> {
  const file = resolve(cwd, env.AUDIT_ENV_FILE || '.env');
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(readFileSync(file, 'utf8'));
  } catch {
    // sin archivo: solo el entorno
  }
  return { ...fromFile, ...env };
}

function num(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Configuración efectiva. Devuelve `null` si falta URL o token (la auditoría queda desactivada, la app arranca igual),
 * salvo en modo demo, que no necesita n8n.
 */
export function readAuditConfig(env: Record<string, string | undefined> = loadEnv()): AuditConfig | null {
  const demo = env.AUDIT_DEMO === '1';
  const baseUrl = (env.N8N_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.N8N_AUDIT_TOKEN ?? '').trim();
  if (!demo && (!baseUrl || !token)) return null;
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return null;
  const rawPath = (env.N8N_AUDIT_WEBHOOK_PATH ?? '/webhook/audit/metricas').trim();
  const tz = (env.APP_TIMEZONE ?? 'America/Bogota').trim();
  return {
    baseUrl,
    webhookPath: rawPath.startsWith('/') ? rawPath : `/${rawPath}`,
    token,
    apiKey: (env.N8N_API_KEY ?? '').trim() || undefined,
    projectId: (env.N8N_PROJECT_ID ?? '').trim() || undefined,
    timezone: validTimezone(tz) ? tz : 'America/Bogota',
    pollIntervalMs: num(env.POLL_INTERVAL_SECONDS, 60, 5, 3600) * 1000,
    requestTimeoutMs: num(env.N8N_REQUEST_TIMEOUT_MS, 15_000, 1000, 120_000),
    rangeDays: num(env.AUDIT_RANGE_DAYS, 30, 1, 365),
    port: num(env.PORT, 3000, 1, 65535),
    demo,
  };
}
