import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import {
  LLM,
  type LlmPort,
  STT,
  type SttPort,
  TTS,
  type TtsPort,
} from './ai.types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { FallbackLlm } from './fallback-llm.js';
import { FallbackTts } from './fallback-tts.js';
import { FaultyLlm, FaultyStt, FaultyTts } from './fault-injection.js';
import { GeminiLlm } from './gemini-llm.js';
import { GeminiStt } from './gemini-stt.js';
import { GeminiTts } from './gemini-tts.js';
import { GENAI, genAiProvider } from './genai.provider.js';
import { ResilientStt } from './resilient-stt.js';

const list = (value: string | undefined, fallback: string): string[] =>
  (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const num = (config: ConfigService, key: string, fallback: number): number => {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${key} must be a non-negative number`);
  return value;
};

/** `AI_FAULT_RATE` > 0 wraps every port with random injected 503s (testing only). */
const faultRate = (config: ConfigService) => num(config, 'AI_FAULT_RATE', 0);

@Module({
  providers: [
    genAiProvider,
    {
      provide: STT,
      inject: [GENAI, ConfigService],
      useFactory: (ai: GoogleGenAI, config: ConfigService): SttPort => {
        let inner: SttPort = new GeminiStt(ai, {
          model: config.get('STT_MODEL') || 'gemini-3.5-transcribe-live',
          languageCodes: list(config.get('STT_LANGUAGES'), 'en-US'),
          silenceDurationMs: num(config, 'STT_SILENCE_MS', 500),
        });
        const rate = faultRate(config);
        if (rate > 0) inner = new FaultyStt(inner, rate);
        return new ResilientStt(inner, {
          budgetMs: num(config, 'STT_RECONNECT_BUDGET_MS', 20_000),
          replayBufferMs: num(config, 'STT_REPLAY_BUFFER_MS', 5000),
        });
      },
    },
    {
      provide: LLM,
      inject: [GENAI, ConfigService],
      useFactory: (ai: GoogleGenAI, config: ConfigService): LlmPort => {
        const rate = faultRate(config);
        const entries = list(
          config.get('LLM_MODELS'),
          'gemini-3.6-flash,gemini-3.5-flash-lite',
        ).map((model) => {
          const port = new GeminiLlm(ai, model);
          return {
            name: port.name,
            port: rate > 0 ? new FaultyLlm(port, rate) : port,
            breaker: new CircuitBreaker(),
          };
        });
        return new FallbackLlm(entries, {
          firstTokenMs: num(config, 'LLM_FIRST_TOKEN_MS', 2500),
        });
      },
    },
    {
      provide: TTS,
      inject: [GENAI, ConfigService],
      useFactory: (ai: GoogleGenAI, config: ConfigService): TtsPort => {
        const rate = faultRate(config);
        const voice = config.get<string>('TTS_VOICE') || 'Kore';
        const entries = list(
          config.get('TTS_MODELS') || config.get('TTS_MODEL'),
          'gemini-3.8-flash-tts',
        ).map((model) => {
          const port = new GeminiTts(ai, model, voice);
          return {
            name: port.name,
            port: rate > 0 ? new FaultyTts(port, rate) : port,
            breaker: new CircuitBreaker(),
          };
        });
        return new FallbackTts(entries, {
          retries: num(config, 'TTS_RETRIES', 2),
          firstChunkMs: num(config, 'TTS_FIRST_CHUNK_MS', 2500),
        });
      },
    },
  ],
  exports: [STT, LLM, TTS],
})
export class AiModule {}
