import { GoogleGenAI } from '@google/genai';
import type { TtsPort } from './ai.types.js';
import { classifyGeminiError, ProviderError } from './provider-error.js';

/**
 * One Gemini TTS model, streaming via the Interactions API (`stream: true`),
 * which delivers headerless PCM s16le (audio/l16) as `step.delta` audio
 * events. Errors are thrown as `ProviderError`s; retries live in `FallbackTts`.
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
    } catch (err) {
      if (signal.aborted) return;
      throw classifyGeminiError(err, this.name);
    }
  }
}
