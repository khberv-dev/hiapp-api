import { ApiError } from '@google/genai';
import {
  classifyGeminiError,
  parseRetryAfter,
  ProviderError,
} from './provider-error.js';
import { backoffDelay, firstEventDeadline, sleep } from './retry.js';
import { CircuitBreaker } from './circuit-breaker.js';

const apiError = (status: number, message = '{}') =>
  new ApiError({ status, message });

describe('classifyGeminiError', () => {
  it.each([
    [apiError(503), 'overloaded', true],
    [apiError(500), 'overloaded', true],
    [
      new Error('The model is overloaded. Please try again later.'),
      'overloaded',
      true,
    ],
    [apiError(429), 'rate_limited', true],
    [new Error('RESOURCE_EXHAUSTED'), 'rate_limited', true],
    [apiError(401), 'auth', false],
    [apiError(403), 'auth', false],
    [
      new Error('closed: 1007 API key not valid. Please pass a valid API key.'),
      'auth',
      false,
    ],
    // google-auth-library failures (GENAI_BACKEND=vertex)
    [
      Object.assign(new Error('invalid_grant: Invalid JWT Signature.'), {
        status: 400,
      }),
      'auth',
      false,
    ],
    [new Error('Could not load the default credentials.'), 'auth', false],
    [apiError(400), 'bad_request', false],
    [apiError(404), 'bad_request', false],
    [new TypeError('fetch failed'), 'network', true],
    [new Error('read ECONNRESET'), 'network', true],
    [new Error('something odd'), 'unknown', true],
  ] as const)('%s → %s', (err, kind, retryable) => {
    const e = classifyGeminiError(err, 'gemini:x');
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
    expect(e.provider).toBe('gemini:x');
  });

  it('reads the status of Interactions API errors too', () => {
    const err = Object.assign(new Error('429 quota'), { status: 429 });
    expect(classifyGeminiError(err, 'p').kind).toBe('rate_limited');
  });

  it('passes ProviderErrors through', () => {
    const e = new ProviderError('timeout', 'p', 'slow');
    expect(classifyGeminiError(e, 'other')).toBe(e);
  });

  it('parses RetryInfo.retryDelay from the message or the error body', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '7s',
          },
        ],
      },
    });
    expect(parseRetryAfter(new ApiError({ status: 429, message: body }))).toBe(
      7000,
    );
    const interactions = Object.assign(new Error('429'), {
      error: { details: [{ retryDelay: '1.5s' }] },
    });
    expect(parseRetryAfter(interactions)).toBe(1500);
    expect(parseRetryAfter(new Error('nope'))).toBeUndefined();
    expect(classifyGeminiError(apiError(429, body), 'p').retryAfterMs).toBe(
      7000,
    );
  });
});

describe('parseRetryAfter with a real 429 shape', () => {
  // As thrown by the Interactions client for a TTS free-tier quota (2026-11-05).
  const real429 = () =>
    Object.assign(
      new Error(
        '429 Rate limit exceeded for model gemini-3.8-flash-tts (limit: 10 requests per day on Free Tier). Please retry in 2h9m16s or upgrade your tier at https://ai.dev/rate-limit.',
      ),
      {
        status: 429,
        headers: new Headers({ 'retry-after': '7756' }),
        error: { error: { code: 'too_many_requests' } },
      },
    );

  it('prefers the retry-after header', () => {
    expect(parseRetryAfter(real429())).toBe(7_756_000);
    expect(classifyGeminiError(real429(), 'p')).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 7_756_000,
    });
  });

  it('falls back to "retry in 2h9m16s" in the message', () => {
    const err = real429();
    err.headers = new Headers();
    expect(parseRetryAfter(err)).toBe((2 * 3600 + 9 * 60 + 16) * 1000);
    expect(parseRetryAfter(new Error('Please retry in 7.5s.'))).toBe(7500);
  });
});

describe('retry helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('backoffDelay is full jitter within [0, min(max, base·2^n)]', () => {
    const opts = { baseMs: 250, maxMs: 4000 };
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelay(3, opts)).toBe(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(backoffDelay(0, opts)).toBeCloseTo(250, 0);
    expect(backoffDelay(3, opts)).toBeCloseTo(2000, 0);
    expect(backoffDelay(10, opts)).toBeCloseTo(4000, 0);
  });

  it('sleep returns early on abort', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const done = sleep(10_000, ctl.signal);
    ctl.abort();
    await done;
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('firstEventDeadline aborts unless disarmed, and tells it from a parent abort', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const d = firstEventDeadline(100, parent.signal);
    vi.advanceTimersByTime(100);
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(true);

    const d2 = firstEventDeadline(100, parent.signal);
    d2.firstEvent();
    vi.advanceTimersByTime(1000);
    expect(d2.signal.aborted).toBe(false);
    parent.abort();
    expect(d2.signal.aborted).toBe(true);
    expect(d2.timedOut()).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens after 5 failures, then lets one trial through after the cool-down', () => {
    let now = 0;
    const breaker = new CircuitBreaker(undefined, () => now);
    for (let i = 0; i < 4; i++) breaker.failure();
    expect(breaker.allow()).toBe(true);
    breaker.failure();
    expect(breaker.allow()).toBe(false);

    now += 19_999;
    expect(breaker.allow()).toBe(false);
    now += 1;
    expect(breaker.allow()).toBe(true); // the trial
    expect(breaker.allow()).toBe(false); // only one at a time

    breaker.failure(); // trial failed: another cool-down
    now += 10_000;
    expect(breaker.allow()).toBe(false);
    now += 10_000;
    expect(breaker.allow()).toBe(true);
    breaker.success();
    expect(breaker.allow()).toBe(true);
    expect(breaker.isOpen).toBe(false);
  });

  it('opens at once for a long server retry hint', () => {
    let now = 0;
    const breaker = new CircuitBreaker(undefined, () => now);
    breaker.failure(2 * 3600_000); // "retry in 2h"
    expect(breaker.allow()).toBe(false);
    now += 3600_000;
    expect(breaker.allow()).toBe(false);
    now += 3600_000;
    expect(breaker.allow()).toBe(true);
  });

  it('only counts failures within the window', () => {
    let now = 0;
    const breaker = new CircuitBreaker(undefined, () => now);
    for (let i = 0; i < 4; i++) breaker.failure();
    now += 30_000;
    breaker.failure();
    expect(breaker.allow()).toBe(true);
  });
});
