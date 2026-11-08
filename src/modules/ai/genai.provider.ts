import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai';

export const GENAI = Symbol('GENAI');

export type GenAiBackend = 'gemini' | 'vertex';

/** <project>/; this file runs from src/modules/ai/ or dist/modules/ai/. */
export const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..');

const DEFAULT_CREDENTIALS_FILE = 'google-service-account.json';

/**
 * Client options for the backend chosen by `GENAI_BACKEND`:
 * - `gemini` (default): Gemini Developer API, `GEMINI_API_KEY`.
 * - `vertex`: Vertex AI, authenticated with a service-account JSON key read
 *   from `GOOGLE_CREDENTIALS_FILE` (relative to the project root, gitignored).
 *   The project defaults to the key's `project_id`, the location to `global`.
 */
export function genAiOptions(
  config: ConfigService,
  root = PROJECT_ROOT,
): GoogleGenAIOptions {
  const backend = (config.get<string>('GENAI_BACKEND') || 'gemini').trim();
  if (backend === 'gemini') {
    return { apiKey: config.getOrThrow<string>('GEMINI_API_KEY') };
  }
  if (backend !== 'vertex') {
    throw new Error(
      `GENAI_BACKEND must be "gemini" or "vertex", got "${backend}"`,
    );
  }

  const file =
    config.get<string>('GOOGLE_CREDENTIALS_FILE') || DEFAULT_CREDENTIALS_FILE;
  const path = isAbsolute(file) ? file : join(root, file);
  let credentials: { project_id?: string; client_email?: string };
  try {
    credentials = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `GENAI_BACKEND=vertex: cannot read service account key ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (!credentials.client_email) {
    throw new Error(`${path} is not a service account key (no client_email)`);
  }

  const project =
    config.get<string>('GOOGLE_CLOUD_PROJECT') || credentials.project_id;
  if (!project) {
    throw new Error(
      `GENAI_BACKEND=vertex: set GOOGLE_CLOUD_PROJECT (${path} has no project_id)`,
    );
  }

  return {
    vertexai: true,
    project,
    location: config.get<string>('GOOGLE_CLOUD_LOCATION') || 'global',
    googleAuthOptions: {
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  };
}

export const genAiProvider: Provider = {
  provide: GENAI,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => new GoogleGenAI(genAiOptions(config)),
};
