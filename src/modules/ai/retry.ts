import { ProviderError } from './provider-error.js';

export interface BackoffOpts {
  baseMs: number;
  maxMs: number;
}

/** Full-jitter exponential delay: random(0, min(max, base·2^n)). */
export const backoffDelay = (n: number, o: BackoffOpts): number =>
  Math.random() * Math.min(o.maxMs, o.baseMs * 2 ** n);

/** Waits `ms`, or returns early when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface FirstEventDeadline {
  /** Aborts when `parent` aborts or the deadline fires first. */
  signal: AbortSignal;
  /** Call on the first event to disarm the deadline. */
  firstEvent(): void;
  /** True if *our* deadline fired (not the parent). */
  timedOut(): boolean;
  dispose(): void;
}

/** A deadline that aborts unless `firstEvent()` is called within `ms`. */
export function firstEventDeadline(
  ms: number,
  parent: AbortSignal,
): FirstEventDeadline {
  const ctl = new AbortController();
  const timer = setTimeout(
    () =>
      ctl.abort(new ProviderError('timeout', '', `no first event in ${ms} ms`)),
    ms,
  );
  return {
    signal: AbortSignal.any([parent, ctl.signal]),
    firstEvent: () => clearTimeout(timer),
    timedOut: () => ctl.signal.aborted && !parent.aborted,
    dispose: () => clearTimeout(timer),
  };
}
