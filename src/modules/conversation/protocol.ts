/**
 * WebSocket protocol for /v1/conversation.
 *
 * Auth: the access token from POST /auth/google in an `Authorization: Bearer`
 * header (not the query string, which ends up in proxy/access logs).
 * Missing/invalid → close 4401.
 *
 * Resume: after a dropped connection the client may reconnect with
 * `?resume=<conversationId>` (from `ready`). If that conversation is the
 * user's and ended less than RESUME_WINDOW_SEC ago (or is still open), it is
 * reopened with its recent turns as LLM context and `ready.resumed` is true;
 * otherwise a new conversation starts. A bad resume id never fails the connect.
 *
 * Client -> server
 *   binary frames: mic audio, PCM s16le 16 kHz mono (~100 ms per frame)
 *   text frames (JSON):
 *     { type: "end_of_audio" }   user stopped talking (push-to-talk release / client VAD)
 *     { type: "interrupt" }      stop the AI's current reply
 *     { type: "ping" }
 *
 * Server -> client
 *   text frames (JSON): ServerMessage. Clients must ignore unknown types.
 *   binary frames: AI voice, PCM s16le mono at `sampleRate` from tts_start
 *   The server also sends WebSocket ping frames; a peer that doesn't pong is
 *   terminated.
 */

export type ServerMessage =
  /**
   * `remainingSec`: seconds left of today's allowance; the server disconnects
   * when it runs out. `conversationId`: pass as `?resume=` after a drop.
   */
  | {
      type: 'ready';
      remainingSec?: number;
      conversationId: string;
      resumed?: boolean;
    }
  /** Daily allowance used up; the server closes with 4403 right after. */
  | { type: 'limit_reached' }
  /**
   * Speech recognition is reconnecting upstream: keep the mic on, audio is
   * buffered and replayed. `ok` when it's back.
   */
  | { type: 'status'; stt: 'reconnecting' | 'ok' }
  | { type: 'transcript_interim'; text: string }
  | { type: 'transcript_final'; turnId: number; text: string }
  | { type: 'llm_delta'; turnId: number; text: string }
  | { type: 'llm_done'; turnId: number; text: string }
  | { type: 'tts_start'; turnId: number; sampleRate: number }
  | { type: 'tts_end'; turnId: number }
  /** Barge-in: the client must flush its playback buffer now. */
  | { type: 'tts_stop'; turnId: number }
  /** Only with SEND_TURN_METRICS=true: per-turn timings in ms (see TurnTimer). */
  | ({ type: 'turn_metrics' } & Record<string, unknown>)
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'pong' };

export const CloseCode = {
  Normal: 1000,
  /** Upstream (speech recognition) unavailable, or the conversation failed to start. */
  InternalError: 1011,
  Unauthorized: 4401,
  /** Daily usage limit reached. */
  LimitReached: 4403,
  /** The same user opened a newer connection. */
  Replaced: 4409,
} as const;

export type ClientMessage =
  { type: 'end_of_audio' } | { type: 'interrupt' } | { type: 'ping' };

const CLIENT_TYPES = new Set(['end_of_audio', 'interrupt', 'ping']);

export function parseClientMessage(raw: string): ClientMessage | undefined {
  try {
    const msg: unknown = JSON.parse(raw);
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      typeof msg.type === 'string' &&
      CLIENT_TYPES.has(msg.type)
    ) {
      return msg as ClientMessage;
    }
  } catch {
    // fall through
  }
  return undefined;
}
