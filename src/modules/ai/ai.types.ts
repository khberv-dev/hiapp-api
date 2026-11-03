/**
 * Provider-agnostic contracts. The conversation layer depends only on these,
 * so tests can swap the Gemini services for fakes.
 */

export interface SttCallbacks {
  /** Low-latency partial text while the user is still speaking. */
  onInterim(text: string): void;
  /** Committed text for a finished utterance. */
  onFinal(text: string): void;
  /** The upstream connection closed without us asking. */
  onUnexpectedClose(reason: string): void;
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

export interface LlmRequest {
  systemPrompt: string;
  history: ChatTurn[];
  signal: AbortSignal;
}

export interface LlmPort {
  /** Yields text deltas. Returns quietly if `signal` is aborted. */
  stream(req: LlmRequest): AsyncIterable<string>;
}

export interface TtsPort {
  /** Sample rate of the PCM s16le mono chunks yielded by `synthesize`. */
  readonly sampleRate: number;
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Buffer>;
}

export const STT = Symbol('STT');
export const LLM = Symbol('LLM');
export const TTS = Symbol('TTS');
