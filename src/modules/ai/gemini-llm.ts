import { type Content, GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { ChatTurn, LlmPort, LlmRequest } from './ai.types.js';
import { classifyGeminiError } from './provider-error.js';

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
 * One Gemini model, streaming. Errors are thrown as `ProviderError`s; retries
 * and fallback live in `FallbackLlm`.
 *
 * Latency tuning: `maxOutputTokens: 400` and `ThinkingLevel.MINIMAL` suit
 * short spoken replies. History is capped by the session (20 turns), so the
 * prompt is too small for context caching to pay off.
 */
export class GeminiLlm implements LlmPort {
  readonly name: string;

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {
    this.name = `gemini:${model}`;
  }

  async *stream({
    systemPrompt,
    history,
    signal,
  }: LlmRequest): AsyncGenerator<string> {
    try {
      // No `httpOptions.retryOptions`: the SDK doesn't retry this call itself.
      const stream = await this.ai.models.generateContentStream({
        model: this.model,
        contents: toContents(history),
        config: {
          systemInstruction: systemPrompt,
          abortSignal: signal,
          maxOutputTokens: 400,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      });
      for await (const chunk of stream) {
        if (signal.aborted) return;
        const text = chunk.text;
        if (text) yield text;
      }
    } catch (err) {
      if (signal.aborted) return;
      throw classifyGeminiError(err, this.name);
    }
  }
}
