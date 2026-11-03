import { Module } from '@nestjs/common';
import { LLM, STT, TTS } from './ai.types.js';
import { genAiProvider } from './genai.provider.js';
import { GeminiLlmService } from './gemini-llm.service.js';
import { GeminiSttService } from './gemini-stt.service.js';
import { GeminiTtsService } from './gemini-tts.service.js';

@Module({
  providers: [
    genAiProvider,
    { provide: STT, useClass: GeminiSttService },
    { provide: LLM, useClass: GeminiLlmService },
    { provide: TTS, useClass: GeminiTtsService },
  ],
  exports: [STT, LLM, TTS],
})
export class AiModule {}
