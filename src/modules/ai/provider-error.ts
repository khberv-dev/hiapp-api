export type ProviderErrorKind =
  | 'overloaded' // 500/503, "model is overloaded", UNAVAILABLE
  | 'rate_limited' // 429, RESOURCE_EXHAUSTED
  | 'timeout' // our own deadline fired
  | 'network' // ECONNRESET, fetch failed, socket closed
  | 'auth' // 401/403, invalid API key
  | 'bad_request' // 400/404: a config or request bug, never retried
  | 'unknown';

const RETRYABLE = new Set<ProviderErrorKind>([
  'overloaded',
  'rate_limited',
  'timeout',
  'network',
  'unknown',
]);

/** A provider failure, classified so the fallback layer knows whether to retry. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    readonly kind: ProviderErrorKind,
    /** e.g. `gemini:gemini-3.6-flash` */
    readonly provider: string,
    message: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/**
 * Maps any error from `@google/genai` to a ProviderError. Covers both error
 * classes the SDK throws: `ApiError` (models/live) and the Interactions
 * client's `APIError` subclasses; both carry a numeric `status`.
 */
export function classifyGeminiError(
  err: unknown,
  provider: string,
): ProviderError {
  if (err instanceof ProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const raw = (err as { status?: unknown } | null)?.status;
  const status = typeof raw === 'number' ? raw : undefined;

  const kind: ProviderErrorKind =
    status === 503 || status === 500 || /overloaded|UNAVAILABLE/i.test(msg)
      ? 'overloaded'
      : status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)
        ? 'rate_limited'
        : status === 401 ||
            status === 403 ||
            /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(
              msg,
            )
          ? 'auth'
          : status === 400 || status === 404
            ? 'bad_request'
            : /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|fetch failed|socket|network/i.test(
                  msg,
                )
              ? 'network'
              : 'unknown';

  return new ProviderError(kind, provider, msg, parseRetryAfter(err), {
    cause: err,
  });
}

/**
 * Server-suggested wait before retrying, in ms. Checked in order (verified
 * against a real 429 from `@google/genai` 2.32 Interactions, 2026-11-05):
 * - the `retry-after` header (seconds or an HTTP date);
 * - a `google.rpc.RetryInfo` detail, `"retryDelay": "7s"`;
 * - the message text, e.g. "Please retry in 2h9m16s".
 */
export function parseRetryAfter(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;

  const headers = (err as { headers?: unknown }).headers;
  if (headers instanceof Headers) {
    const value = headers.get('retry-after');
    if (value) {
      const secs = Number(value);
      if (Number.isFinite(secs)) return Math.round(secs * 1000);
      const at = Date.parse(value);
      if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    }
  }

  let text = err.message;
  const body = (err as { error?: unknown }).error;
  if (body !== undefined) {
    try {
      text += JSON.stringify(body);
    } catch {
      // ignore unserializable bodies
    }
  }
  const info = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  if (info) return Math.round(Number(info[1]) * 1000);

  const human =
    /retry in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?/i.exec(text);
  if (human && (human[1] || human[2] || human[3])) {
    const [h, m, sec] = [human[1], human[2], human[3]].map((v) =>
      Number(v ?? 0),
    );
    return Math.round(((h * 60 + m) * 60 + sec) * 1000);
  }
  return undefined;
}
