export interface CircuitBreakerOptions {
  /** Retryable failures within `windowMs` that open the circuit. */
  threshold: number;
  windowMs: number;
  /** How long an open circuit refuses requests before a trial. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER: CircuitBreakerOptions = {
  threshold: 5,
  windowMs: 30_000,
  cooldownMs: 20_000,
};

/**
 * Tiny in-process breaker for one provider entry. During an outage the
 * fallback chain skips an open entry instead of paying its deadline on every
 * turn. After the cool-down one trial request is let through (half-open):
 * success closes the circuit, failure re-opens it.
 */
export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil?: number;
  private trialAt?: number;

  constructor(
    private readonly opts: CircuitBreakerOptions = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  get isOpen(): boolean {
    return this.openUntil !== undefined;
  }

  allow(): boolean {
    if (this.openUntil === undefined) return true;
    const t = this.now();
    if (t < this.openUntil) return false;
    // Half-open: one trial at a time. A trial that never reports back (e.g.
    // its turn was aborted) frees the slot after another cool-down.
    if (this.trialAt !== undefined && t - this.trialAt < this.opts.cooldownMs)
      return false;
    this.trialAt = t;
    return true;
  }

  success(): void {
    this.failures = [];
    this.openUntil = undefined;
    this.trialAt = undefined;
  }

  /**
   * `retryAfterMs`: the server's own hint (e.g. a 429 "retry in 2h"). A hint
   * at least as long as the cool-down opens the circuit right away, for that
   * long: retrying earlier is pointless.
   */
  failure(retryAfterMs = 0): void {
    const t = this.now();
    const openFor = Math.max(this.opts.cooldownMs, retryAfterMs);
    if (this.openUntil !== undefined) {
      // The half-open trial failed: stay open for another cool-down.
      this.openUntil = t + openFor;
      this.trialAt = undefined;
      return;
    }
    this.failures = this.failures.filter((f) => t - f < this.opts.windowMs);
    this.failures.push(t);
    if (
      retryAfterMs >= this.opts.cooldownMs ||
      this.failures.length >= this.opts.threshold
    ) {
      this.openUntil = t + openFor;
      this.failures = [];
    }
  }
}
