import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Content, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { GENAI } from './genai.provider.js';
import type { ChatTurn, LlmPort, LlmRequest } from './ai.types.js';

/** Gemini wants alternating roles starting with "user"; merge repeats. */
export function toContents(history: ChatTurn[]): Content[] {
  const out: Content[] = [];
  for (const turn of history) {
    const role = turn.role === 'assistant' ? 'model' : 'user';
    const last = out.at(-1);
    if (last?.role === role) {
      last.parts = [{ text: `${last.parts?.[0]?.text ?? ''}\n${turn.text}` }];
    } else {
      out.push({ role, parts: [{ text: turn.text }] });
    }
  }
  if (out[0]?.role === 'model')
    out.unshift({ role: 'user', parts: [{ text: 'Hi!' }] });
  return out;
}

/**
 * Streaming text generation with a model fallback chain. A model that fails
 * before its first token is skipped; a failure after tokens were sent is
 * rethrown, because the user has already heard part of the answer.
 */
@Injectable()
export class GeminiLlmService implements LlmPort {
  private readonly logger = new Logger(GeminiLlmService.name);
  private readonly models: string[];

  constructor(
    @Inject(GENAI) private readonly ai: GoogleGenAI,
    config: ConfigService,
  ) {
    this.models = (
      config.get<string>('LLM_MODELS') ??
      'gemini-3.6-flash,gemini-3.5-flash-lite'
    )
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  async *stream({
    systemPrompt,
    history,
    signal,
  }: LlmRequest): AsyncGenerator<string> {
    const contents = toContents(history);
    let lastError: unknown;

    for (const model of this.models) {
      let emitted = false;
      try {
        const stream = await this.ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction: systemPrompt,
            abortSignal: signal,
            maxOutputTokens: 400,
            // Lowest latency: spoken replies are short and don't need reasoning.
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        });
        for await (const chunk of stream) {
          if (signal.aborted) return;
          const text = chunk.text;
          if (text) {
            emitted = true;
            yield text;
          }
        }
        return;
      } catch (err) {
        if (signal.aborted) return;
        if (emitted) throw err;
        lastError = err;
        this.logger.warn(
          `LLM model ${model} failed, trying next: ${String(err)}`,
        );
      }
    }
    throw lastError ?? new Error('No LLM models configured');
  }
}
