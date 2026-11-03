import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { GENAI } from './genai.provider.js';
import type { TtsPort } from './ai.types.js';

/**
 * Streaming text-to-speech via the Interactions API (`stream: true`), which
 * delivers headerless PCM s16le (audio/l16) as `step.delta` audio events.
 */
@Injectable()
export class GeminiTtsService implements TtsPort {
  readonly sampleRate = 24000;
  private readonly model: string;
  private readonly voice: string;

  constructor(
    @Inject(GENAI) private readonly ai: GoogleGenAI,
    config: ConfigService,
  ) {
    this.model = config.get('TTS_MODEL') ?? 'gemini-3.8-flash-tts';
    this.voice = config.get('TTS_VOICE') ?? 'Kore';
  }

  async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
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
      { fetch_options: { signal } },
    );

    for await (const event of stream) {
      if (signal.aborted) return;
      if (event.event_type === 'error') {
        throw new Error(`TTS error: ${event.error?.message ?? 'unknown'}`);
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
}
