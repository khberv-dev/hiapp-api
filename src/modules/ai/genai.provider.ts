import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';

export const GENAI = Symbol('GENAI');

export const genAiProvider: Provider = {
  provide: GENAI,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new GoogleGenAI({ apiKey: config.getOrThrow<string>('GEMINI_API_KEY') }),
};
