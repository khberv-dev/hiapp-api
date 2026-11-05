/**
 * Provider-agnostic contracts. The conversation layer depends only on these,
 * so tests can swap the Gemini services for fakes.
 */

export interface SttCallbacks {
  /** Low-latency partial text while the user is still speaking. */
  onInterim(text: string): void;
  /** Committed text for a finished utterance. */
  onFinal(text: string): void;
  /**
   * The connection is gone for good. From a resilient wrapper this means
   * reconnecting failed (budget exhausted or an auth error).
   */
  onUnexpectedClose(reason: string): void;
  /** The server will end this connection soon (Live API `goAway`). */
  onGoAway?(timeLeftMs?: number): void;
  /** Reported by a resilient wrapper while it reconnects transparently. */
  onStatus?(status: 'reconnecting' | 'ok'): void;
}

export interface SttConnection {
  /** PCM s16le, 16 kHz, mono. */
  sendAudio(pcm: Buffer): void;
  /** The user stopped talking (e.g. push-to-talk released): finalize quickly. */
  endOfAudio(): void;
  close(): void;
}

export interface SttPort {
  connect(cb: SttCallbacks): Promise<SttConnection>;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Which provider entry actually served a request, e.g. `gemini:gemini-3.6-flash`. */
export type OnServed = (provider: string) => void;

export interface LlmRequest {
  systemPrompt: string;
  history: ChatTurn[];
  signal: AbortSignal;
  onServed?: OnServed;
}

export interface LlmPort {
  /** Yields text deltas. Returns quietly if `signal` is aborted. */
  stream(req: LlmRequest): AsyncIterable<string>;
}

export interface TtsPort {
  /** Sample rate of the PCM s16le mono chunks yielded by `synthesize`. */
  readonly sampleRate: number;
  synthesize(
    text: string,
    signal: AbortSignal,
    onServed?: OnServed,
  ): AsyncIterable<Buffer>;
}

export const STT = Symbol('STT');
export const LLM = Symbol('LLM');
export const TTS = Symbol('TTS');
