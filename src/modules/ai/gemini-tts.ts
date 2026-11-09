import { GoogleGenAI, Modality } from '@google/genai';
import type { TtsPort } from './ai.types.js';
import { classifyGeminiError, ProviderError } from './provider-error.js';

/**
 * One Gemini TTS model, yielding headerless PCM s16le mono. The API depends
 * on the client's backend:
 * - Gemini Developer API: the Interactions API (`stream: true`), which sends
 *   audio/l16 as `step.delta` audio events.
 * - Vertex AI: the Interactions API rejects TTS models there ("not supported
 *   by the Interactions API"), so it uses `models.generateContentStream` with
 *   `responseModalities: AUDIO`, which streams `audio/l16; rate=24000` parts.
 *
 * Errors are thrown as `ProviderError`s; retries live in `FallbackTts`.
 */
export class GeminiTts implements TtsPort {
  readonly name: string;

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
    private readonly voice: string,
    readonly sampleRate = 24000,
  ) {
    this.name = `gemini:${model}`;
  }

  async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    try {
      yield* this.ai.vertexai
        ? this.viaGenerateContent(text, signal)
        : this.viaInteractions(text, signal);
    } catch (err) {
      if (signal.aborted) return;
      throw classifyGeminiError(err, this.name);
    }
  }

  private async *viaInteractions(
    text: string,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    const stream = await this.ai.interactions.create(
      {
        model: this.model,
        input: text,
        stream: true,
        store: false,
        response_modalities: ['audio'],
        response_format: {
          type: 'audio',
          mime_type: 'audio/l16',
          sample_rate: this.sampleRate,
        },
        generation_config: { speech_config: [{ voice: this.voice }] },
      },
      // The Interactions client otherwise retries 429/5xx by itself, up to
      // 4 times over as long as 30 s, which would stall the sentence.
      // FallbackTts retries with a much tighter budget instead.
      { fetch_options: { signal }, maxRetries: 0 },
    );

    for await (const event of stream) {
      if (signal.aborted) return;
      if (event.event_type === 'error') {
        throw new ProviderError(
          classifyGeminiError(
            new Error(event.error?.message ?? 'unknown'),
            this.name,
          ).kind,
          this.name,
          `TTS stream error: ${event.error?.message ?? 'unknown'}`,
        );
      }
      if (
        event.event_type === 'step.delta' &&
        event.delta.type === 'audio' &&
        event.delta.data
      ) {
        yield Buffer.from(event.delta.data, 'base64');
      }
    }
  }

  private async *viaGenerateContent(
    text: string,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    // No `httpOptions.retryOptions`: the SDK doesn't retry this call itself.
    const stream = await this.ai.models.generateContentStream({
      model: this.model,
      contents: text,
      config: {
        abortSignal: signal,
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
        },
      },
    });

    for await (const chunk of stream) {
      if (signal.aborted) return;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        const data = part.inlineData?.data;
        if (!data) continue;
        this.checkRate(part.inlineData?.mimeType);
        yield Buffer.from(data, 'base64');
      }
    }
  }

  /** The output rate isn't selectable here; a mismatch would play garbled. */
  private checkRate(mimeType: string | undefined): void {
    const rate = /rate=(\d+)/.exec(mimeType ?? '')?.[1];
    if (rate && Number(rate) !== this.sampleRate) {
      throw new ProviderError(
        'bad_request',
        this.name,
        `TTS returned ${mimeType}, expected ${this.sampleRate} Hz`,
      );
    }
  }
}
