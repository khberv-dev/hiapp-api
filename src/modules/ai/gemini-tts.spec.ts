import type { GoogleGenAI } from '@google/genai';
import { GeminiTts } from './gemini-tts.js';
import { ProviderError } from './provider-error.js';

const part = (
  bytes: number[],
  mimeType = 'audio/l16; rate=24000; channels=1',
) => ({
  candidates: [
    {
      content: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: Buffer.from(bytes).toString('base64'),
            },
          },
        ],
      },
    },
  ],
});

async function* chunks(...items: unknown[]) {
  for (const item of items) yield item;
}

const collect = async (gen: AsyncGenerator<Buffer>) => {
  const out: Buffer[] = [];
  for await (const b of gen) out.push(b);
  return out;
};

describe('GeminiTts on Vertex AI', () => {
  const fakeAi = (impl: (req: any) => Promise<AsyncGenerator<unknown>>) => {
    const generateContentStream = vi.fn(impl);
    const create = vi.fn();
    const ai = {
      vertexai: true,
      models: { generateContentStream },
      interactions: { create },
    } as unknown as GoogleGenAI;
    return { ai, generateContentStream, create };
  };

  it('streams audio parts via generateContentStream, not Interactions', async () => {
    const { ai, generateContentStream, create } = fakeAi(async () =>
      chunks(
        part([1, 2]),
        { candidates: [{ content: { parts: [{}] } }] },
        part([3]),
      ),
    );
    const tts = new GeminiTts(ai, 'gemini-3.8-flash-tts', 'Kore');
    const out = await collect(
      tts.synthesize('Hi.', new AbortController().signal),
    );

    expect(Buffer.concat(out)).toEqual(Buffer.from([1, 2, 3]));
    expect(create).not.toHaveBeenCalled();
    const req = generateContentStream.mock.calls[0][0];
    expect(req).toMatchObject({
      model: 'gemini-3.8-flash-tts',
      contents: 'Hi.',
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    });
  });

  it('rejects audio at a different sample rate as bad_request', async () => {
    const { ai } = fakeAi(async () =>
      chunks(part([1], 'audio/l16; rate=16000; channels=1')),
    );
    const tts = new GeminiTts(ai, 'm', 'Kore');
    const err = await collect(
      tts.synthesize('Hi.', new AbortController().signal),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('bad_request');
  });

  it('classifies API errors', async () => {
    const { ai } = fakeAi(() =>
      Promise.reject(Object.assign(new Error('not found'), { status: 404 })),
    );
    const err = await collect(
      new GeminiTts(ai, 'm', 'Kore').synthesize(
        'Hi.',
        new AbortController().signal,
      ),
    ).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('bad_request');
  });
});
