import { Logger } from '@nestjs/common';
import type { OnServed, TtsPort } from './ai.types.js';
import { type FallbackEntry, fallbackStream } from './fallback.js';
import { backoffDelay } from './retry.js';

export interface FallbackTtsOptions {
  /** Extra attempts per entry before moving to the next one. */
  retries: number;
  /** An attempt that yields no audio within this time is abandoned. */
  firstChunkMs: number;
}

const BACKOFF = { baseMs: 150, maxMs: 1500 };

/**
 * TTS chain with per-sentence retries. Before the first chunk, a retryable
 * error or a missed deadline is retried (jittered backoff) and then handed to
 * the next entry; after the first chunk an error is rethrown, because part of
 * the sentence was already played. All entries must share one sample rate:
 * an adapter for a different-rate provider must resample to it.
 */
export class FallbackTts implements TtsPort {
  readonly sampleRate: number;
  private readonly logger = new Logger(FallbackTts.name);

  constructor(
    private readonly entries: FallbackEntry<TtsPort>[],
    private readonly opts: FallbackTtsOptions,
  ) {
    if (entries.length === 0) throw new Error('FallbackTts needs an entry');
    this.sampleRate = entries[0].port.sampleRate;
    const odd = entries.find((e) => e.port.sampleRate !== this.sampleRate);
    if (odd) {
      throw new Error(
        `TTS ${odd.name} outputs ${odd.port.sampleRate} Hz, expected ${this.sampleRate} Hz`,
      );
    }
  }

  synthesize(
    text: string,
    signal: AbortSignal,
    onServed?: OnServed,
  ): AsyncIterable<Buffer> {
    return fallbackStream(
      this.entries,
      {
        firstEventMs: this.opts.firstChunkMs,
        retryDelay: (err, attempt) => {
          if (attempt >= this.opts.retries) return undefined;
          const delay = backoffDelay(attempt, BACKOFF);
          if (err.kind !== 'rate_limited') return delay;
          // Honour the server's hint for a 429; if it's longer than we'd
          // ever wait for one sentence (e.g. a daily quota), move on.
          const hint = err.retryAfterMs ?? 0;
          return hint > BACKOFF.maxMs ? undefined : Math.max(hint, delay);
        },
      },
      signal,
      (port, s) => port.synthesize(text, s),
      onServed,
      this.logger,
    );
  }
}
