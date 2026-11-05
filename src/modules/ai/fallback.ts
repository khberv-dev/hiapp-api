import { Logger } from '@nestjs/common';
import { CircuitBreaker } from './circuit-breaker.js';
import type { OnServed } from './ai.types.js';
import { classifyGeminiError, ProviderError } from './provider-error.js';
import { firstEventDeadline, sleep } from './retry.js';

export interface FallbackEntry<P> {
  /** `<provider>:<model>`, reported through `onServed` and in logs. */
  name: string;
  port: P;
  breaker?: CircuitBreaker;
}

export interface FallbackPolicy {
  /** Each attempt must yield its first item within this time. */
  firstEventMs: number;
  /**
   * Delay before retrying the same entry after a retryable `err` on attempt
   * `n` (0-based), or `undefined` to move on to the next entry.
   */
  retryDelay(err: ProviderError, attempt: number): number | undefined;
}

/**
 * Streams from the first entry that produces a first item in time:
 * - a non-retryable error (`auth`, `bad_request`) is thrown at once, so a
 *   config bug doesn't burn the whole chain;
 * - a retryable error or a missed first-event deadline is retried on the same
 *   entry (per `policy`) or skipped to the next entry;
 * - an error *after* the first item is rethrown: part of the output has
 *   already reached the user.
 * Returns quietly when `signal` aborts.
 */
export async function* fallbackStream<P, T>(
  entries: FallbackEntry<P>[],
  policy: FallbackPolicy,
  signal: AbortSignal,
  open: (port: P, signal: AbortSignal) => AsyncIterable<T>,
  onServed: OnServed | undefined,
  logger: Logger,
): AsyncGenerator<T> {
  // During a full outage every circuit may be open; then try them anyway
  // rather than failing without a single attempt.
  let usable = entries.filter((e) => e.breaker?.allow() ?? true);
  if (usable.length === 0) usable = entries;
  let lastError: ProviderError | undefined;

  for (const entry of usable) {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return;
      const deadline = firstEventDeadline(policy.firstEventMs, signal);
      let emitted = false;
      let error: ProviderError;
      try {
        for await (const item of open(entry.port, deadline.signal)) {
          if (signal.aborted) return;
          if (!emitted) {
            emitted = true;
            deadline.firstEvent();
            entry.breaker?.success();
            onServed?.(entry.name);
          }
          yield item;
        }
        if (signal.aborted) return;
        if (emitted || !deadline.timedOut()) {
          entry.breaker?.success();
          return;
        }
        error = timeoutError(entry.name, policy.firstEventMs);
      } catch (err) {
        if (signal.aborted) return;
        if (emitted) throw classifyGeminiError(err, entry.name);
        error = deadline.timedOut()
          ? timeoutError(entry.name, policy.firstEventMs)
          : classifyGeminiError(err, entry.name);
      } finally {
        deadline.dispose();
      }

      if (!error.retryable) throw error;
      entry.breaker?.failure(error.retryAfterMs);
      lastError = error;
      const delay = policy.retryDelay(error, attempt);
      logger.warn(
        `${entry.name} failed (${error.kind}: ${error.message.slice(0, 200)}); ` +
          (delay === undefined
            ? 'trying next'
            : `retrying in ${Math.round(delay)} ms`),
      );
      if (delay === undefined) break;
      await sleep(delay, signal);
    }
  }
  throw (
    lastError ??
    new ProviderError('unknown', 'fallback', 'no providers configured')
  );
}

function timeoutError(provider: string, ms: number): ProviderError {
  return new ProviderError('timeout', provider, `no first event in ${ms} ms`);
}
