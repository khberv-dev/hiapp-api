import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface Window {
  count: number;
  resetAt: number;
}

export interface LoginRateLimits {
  /** Attempts per email per window; a successful sign-in resets it. */
  maxPerEmail: number;
  /** Attempts per client IP per window, successful or not. */
  maxPerIp: number;
  windowMs: number;
}

/**
 * In-memory fixed-window limiter for `POST /auth/login`, per process.
 *
 * Attempts are counted when they start, not when they fail, so parallel
 * requests can't all slip through while their password checks run. The email
 * key is counted whether or not the account exists, so the limit itself
 * doesn't reveal which emails are registered.
 */
@Injectable()
export class LoginRateLimiter implements OnModuleDestroy {
  private readonly byEmail = new Map<string, Window>();
  private readonly byIp = new Map<string, Window>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly limits: LoginRateLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), limits.windowMs);
    this.sweeper.unref();
  }

  static fromConfig(config: ConfigService): LoginRateLimiter {
    const num = (key: string, fallback: number) => {
      const raw = config.get<string>(key);
      if (raw === undefined || raw === '') return fallback;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1)
        throw new Error(`${key} must be a positive integer`);
      return value;
    };
    return new LoginRateLimiter({
      maxPerEmail: num('AUTH_LOGIN_MAX_PER_EMAIL', 5),
      maxPerIp: num('AUTH_LOGIN_MAX_PER_IP', 20),
      windowMs: num('AUTH_LOGIN_WINDOW_SEC', 900) * 1000,
    });
  }

  /**
   * Records an attempt. Returns 0 if it may proceed, otherwise the seconds
   * until it may be retried (the attempt is then not counted).
   */
  consume(ip: string, email: string): number {
    const now = this.now();
    const ipWin = this.current(this.byIp, ip, now);
    const emailWin = this.current(this.byEmail, email, now);

    const waits = [
      ipWin.count >= this.limits.maxPerIp ? ipWin.resetAt - now : 0,
      emailWin.count >= this.limits.maxPerEmail ? emailWin.resetAt - now : 0,
    ];
    const waitMs = Math.max(...waits);
    if (waitMs > 0) return Math.ceil(waitMs / 1000);

    ipWin.count++;
    emailWin.count++;
    return 0;
  }

  /** A successful sign-in clears that email's counter (not the IP's). */
  succeeded(email: string): void {
    this.byEmail.delete(email);
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  private current(map: Map<string, Window>, key: string, now: number) {
    let win = map.get(key);
    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + this.limits.windowMs };
      map.set(key, win);
    }
    return win;
  }

  /** Drops expired windows so the maps don't grow without bound. */
  private sweep(): void {
    const now = this.now();
    for (const map of [this.byEmail, this.byIp]) {
      for (const [key, win] of map) if (win.resetAt <= now) map.delete(key);
    }
  }
}
