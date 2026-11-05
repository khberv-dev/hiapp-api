import { Logger } from '@nestjs/common';
import type { LlmPort, LlmRequest } from './ai.types.js';
import { type FallbackEntry, fallbackStream } from './fallback.js';
import { backoffDelay } from './retry.js';

export interface FallbackLlmOptions {
  /** A model that sends no token within this time is abandoned. */
  firstTokenMs: number;
}

/**
 * LLM chain across models (and, later, providers). Per entry:
 * - first-token deadline missed → next entry right away (speed beats a retry);
 * - `overloaded` / `network` / `unknown` → one retry after a short jittered
 *   backoff, then the next entry;
 * - `rate_limited` → next entry right away (hammering a 429 makes it worse);
 * - `auth` / `bad_request` → thrown immediately.
 */
export class FallbackLlm implements LlmPort {
  private readonly logger = new Logger(FallbackLlm.name);

  constructor(
    private readonly entries: FallbackEntry<LlmPort>[],
    private readonly opts: FallbackLlmOptions,
  ) {
    if (entries.length === 0) throw new Error('FallbackLlm needs an entry');
  }

  stream(req: LlmRequest): AsyncIterable<string> {
    return fallbackStream(
      this.entries,
      {
        firstEventMs: this.opts.firstTokenMs,
        retryDelay: (err, attempt) =>
          attempt === 0 &&
          (err.kind === 'overloaded' ||
            err.kind === 'network' ||
            err.kind === 'unknown')
            ? backoffDelay(0, { baseMs: 200, maxMs: 800 })
            : undefined,
      },
      req.signal,
      (port, signal) => port.stream({ ...req, signal, onServed: undefined }),
      req.onServed,
      this.logger,
    );
  }
}
