import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { genAiOptions } from './genai.provider.js';

const cfg = (env: Record<string, string>) =>
  new ConfigService(env) as ConfigService;

describe('genAiOptions', () => {
  const root = mkdtempSync(join(tmpdir(), 'genai-'));
  const key = {
    type: 'service_account',
    project_id: 'key-project',
    client_email: 'svc@key-project.iam.gserviceaccount.com',
    private_key: 'x',
  };
  writeFileSync(join(root, 'google-service-account.json'), JSON.stringify(key));
  writeFileSync(join(root, 'other.json'), JSON.stringify(key));
  writeFileSync(join(root, 'not-a-key.json'), '{"foo":1}');

  it('defaults to the Gemini Developer API with an API key', () => {
    expect(genAiOptions(cfg({ GEMINI_API_KEY: 'k' }), root)).toEqual({
      apiKey: 'k',
    });
    expect(() => genAiOptions(cfg({}), root)).toThrow(/GEMINI_API_KEY/);
  });

  it('uses the default key file in the project root for vertex', () => {
    const opts = genAiOptions(cfg({ GENAI_BACKEND: 'vertex' }), root);
    expect(opts).toMatchObject({
      vertexai: true,
      project: 'key-project',
      location: 'global',
      googleAuthOptions: { credentials: key },
    });
    expect(opts.apiKey).toBeUndefined();
  });

  it('honours GOOGLE_CREDENTIALS_FILE, project and location overrides', () => {
    const opts = genAiOptions(
      cfg({
        GENAI_BACKEND: 'vertex',
        GOOGLE_CREDENTIALS_FILE: 'other.json',
        GOOGLE_CLOUD_PROJECT: 'p2',
        GOOGLE_CLOUD_LOCATION: 'europe-west4',
      }),
      root,
    );
    expect(opts).toMatchObject({ project: 'p2', location: 'europe-west4' });
  });

  it('fails fast on a missing or invalid key file', () => {
    expect(() =>
      genAiOptions(
        cfg({ GENAI_BACKEND: 'vertex', GOOGLE_CREDENTIALS_FILE: 'nope.json' }),
        root,
      ),
    ).toThrow(/cannot read service account key/);
    expect(() =>
      genAiOptions(
        cfg({
          GENAI_BACKEND: 'vertex',
          GOOGLE_CREDENTIALS_FILE: 'not-a-key.json',
        }),
        root,
      ),
    ).toThrow(/not a service account key/);
  });

  it('rejects an unknown backend', () => {
    expect(() => genAiOptions(cfg({ GENAI_BACKEND: 'openai' }), root)).toThrow(
      /GENAI_BACKEND/,
    );
  });
});
