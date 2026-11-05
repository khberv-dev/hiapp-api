import type {
  LlmPort,
  LlmRequest,
  OnServed,
  SttCallbacks,
  SttConnection,
  SttPort,
  TtsPort,
} from './ai.types.js';
import { ProviderError } from './provider-error.js';

/**
 * Test-only decorators (env `AI_FAULT_RATE`, e.g. 0.2): each request fails
 * with a 503-like `overloaded` error with probability `rate` before producing
 * anything, and each live STT connection is dropped with that probability
 * every 10 s. Used to verify the resilience layer end to end.
 */
const overloaded = (name: string) =>
  new ProviderError('overloaded', name, 'injected fault: 503 overloaded');

export class FaultyLlm implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly rate: number,
    private readonly random = Math.random,
  ) {}

  async *stream(req: LlmRequest): AsyncGenerator<string> {
    if (this.random() < this.rate) throw overloaded('fault:llm');
    yield* this.inner.stream(req);
  }
}

export class FaultyTts implements TtsPort {
  readonly sampleRate: number;

  constructor(
    private readonly inner: TtsPort,
    private readonly rate: number,
    private readonly random = Math.random,
  ) {
    this.sampleRate = inner.sampleRate;
  }

  async *synthesize(
    text: string,
    signal: AbortSignal,
    onServed?: OnServed,
  ): AsyncGenerator<Buffer> {
    if (this.random() < this.rate) throw overloaded('fault:tts');
    yield* this.inner.synthesize(text, signal, onServed);
  }
}

export class FaultyStt implements SttPort {
  constructor(
    private readonly inner: SttPort,
    private readonly rate: number,
    private readonly random = Math.random,
    private readonly dropEveryMs = 10_000,
  ) {}

  async connect(cb: SttCallbacks): Promise<SttConnection> {
    if (this.random() < this.rate) throw overloaded('fault:stt');
    let dropped = false;
    const conn = await this.inner.connect({
      ...cb,
      onUnexpectedClose: (reason) => {
        clearInterval(timer);
        if (!dropped) cb.onUnexpectedClose(reason);
      },
    });
    const timer = setInterval(() => {
      if (this.random() >= this.rate) return;
      dropped = true;
      clearInterval(timer);
      conn.close();
      cb.onUnexpectedClose('injected fault: connection dropped');
    }, this.dropEveryMs);
    return {
      sendAudio: (pcm) => conn.sendAudio(pcm),
      endOfAudio: () => conn.endOfAudio(),
      close: () => {
        clearInterval(timer);
        conn.close();
      },
    };
  }
}
