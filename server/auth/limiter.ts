// Límite de intentos fallidos de inicio de sesión (en memoria, ventana fija). Frena la adivinanza de contraseñas.
// Al reiniciar el servidor se reinicia el conteo: es una defensa de proceso, no una lista de bloqueo permanente.
export class AttemptLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(key: string): { count: number; resetAt: number } | undefined {
    const e = this.hits.get(key);
    if (e && e.resetAt <= this.now()) {
      this.hits.delete(key);
      return undefined;
    }
    return e;
  }

  /** Segundos hasta poder reintentar; 0 si no está bloqueado. */
  retryAfter(key: string): number {
    const e = this.entry(key);
    return e && e.count >= this.max ? Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000)) : 0;
  }

  fail(key: string): void {
    const e = this.entry(key) ?? { count: 0, resetAt: this.now() + this.windowMs };
    e.count++;
    this.hits.set(key, e);
    // Tope de memoria: un atacante que varía el usuario no debe poder crecer el mapa sin límite.
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= this.now() || this.hits.size > 4000) this.hits.delete(k);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
