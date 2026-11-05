import type { GoogleGenAI, LiveCallbacks } from '@google/genai';
import { GeminiStt } from './gemini-stt.js';

function fakeAi() {
  let callbacks!: LiveCallbacks;
  let config: unknown;
  const session = { close: vi.fn(), sendRealtimeInput: vi.fn() };
  const ai = {
    live: {
      connect: vi.fn(
        (params: { callbacks: LiveCallbacks; config: unknown }) => {
          callbacks = params.callbacks;
          config = params.config;
          return Promise.resolve(session);
        },
      ),
    },
  } as unknown as GoogleGenAI;
  return { ai, session, cb: () => callbacks, config: () => config };
}

const opts = {
  model: 'gemini-3.5-transcribe-live',
  languageCodes: ['en-US'],
  silenceDurationMs: 500,
};

const callbacks = () => ({
  onInterim: vi.fn(),
  onFinal: vi.fn(),
  onUnexpectedClose: vi.fn(),
  onGoAway: vi.fn(),
});

describe('GeminiStt', () => {
  it('pins the language and tunes end-of-speech detection', async () => {
    const { ai, config } = fakeAi();
    await new GeminiStt(ai, opts).connect(callbacks());
    expect(config()).toMatchObject({
      inputAudioTranscription: { languageCodes: ['en-US'] },
      realtimeInputConfig: {
        automaticActivityDetection: {
          silenceDurationMs: 500,
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        },
      },
    });
  });

  it('reports goAway without treating it as a failure', async () => {
    const { ai, session, cb } = fakeAi();
    const handlers = callbacks();
    const conn = await new GeminiStt(ai, opts).connect(handlers);
    cb().onmessage({ goAway: { timeLeft: '12.5s' } } as never);
    expect(handlers.onGoAway).toHaveBeenCalledWith(12_500);
    expect(handlers.onUnexpectedClose).not.toHaveBeenCalled();

    // Still usable, and close() still closes the Live session.
    conn.sendAudio(Buffer.from('pcm'));
    expect(session.sendRealtimeInput).toHaveBeenCalled();
    conn.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('closes the Live session it leaves when the connection fails', async () => {
    const { ai, session, cb } = fakeAi();
    const handlers = callbacks();
    await new GeminiStt(ai, opts).connect(handlers);
    cb().onerror!({ message: 'boom' } as ErrorEvent);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(handlers.onUnexpectedClose).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing send into a failure instead of an exception', async () => {
    const { ai, session } = fakeAi();
    const handlers = callbacks();
    const conn = await new GeminiStt(ai, opts).connect(handlers);
    session.sendRealtimeInput.mockImplementation(() => {
      throw new Error('WebSocket is not open');
    });
    expect(() => conn.sendAudio(Buffer.from('pcm'))).not.toThrow();
    expect(handlers.onUnexpectedClose).toHaveBeenCalledTimes(1);
  });

  it('rejects connect with a classified error when closed before setup', async () => {
    let callbacks!: LiveCallbacks;
    const ai = {
      live: {
        connect: (params: { callbacks: LiveCallbacks }) => {
          callbacks = params.callbacks;
          return new Promise(() => undefined); // the SDK never settles
        },
      },
    } as unknown as GoogleGenAI;
    const pending = new GeminiStt(ai, opts).connect({
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onUnexpectedClose: vi.fn(),
    });
    callbacks.onclose!({
      code: 1007,
      reason: 'API key not valid',
    } as CloseEvent);
    await expect(pending).rejects.toMatchObject({ kind: 'auth' });
  });
});
