/**
 * WebSocket protocol for /v1/conversation?token=<accessToken>.
 *
 * Auth: the access token from POST /auth/google, as the `token` query param
 * or an `Authorization: Bearer` header. Missing/invalid → close 4401.
 *
 * Client -> server
 *   binary frames: mic audio, PCM s16le 16 kHz mono (~100 ms per frame)
 *   text frames (JSON):
 *     { type: "end_of_audio" }   user stopped talking (push-to-talk release)
 *     { type: "interrupt" }      stop the AI's current reply
 *     { type: "ping" }
 *
 * Server -> client
 *   text frames (JSON): ServerMessage
 *   binary frames: AI voice, PCM s16le mono at `sampleRate` from tts_start
 */

export type ServerMessage =
  /** `remainingSec`: seconds left of today's allowance; the server disconnects when it runs out. */
  | { type: 'ready'; remainingSec?: number }
  /** Daily allowance used up; the server closes with 4403 right after. */
  | { type: 'limit_reached' }
  | { type: 'transcript_interim'; text: string }
  | { type: 'transcript_final'; turnId: number; text: string }
  | { type: 'llm_delta'; turnId: number; text: string }
  | { type: 'llm_done'; turnId: number; text: string }
  | { type: 'tts_start'; turnId: number; sampleRate: number }
  | { type: 'tts_end'; turnId: number }
  /** Barge-in: the client must flush its playback buffer now. */
  | { type: 'tts_stop'; turnId: number }
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
