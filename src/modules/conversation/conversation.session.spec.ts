import type {
  LlmPort,
  LlmRequest,
  SttCallbacks,
  SttConnection,
  SttPort,
  TtsPort,
} from '../ai/ai.types.js';
import {
  ConversationSession,
  type SessionTransport,
} from './conversation.session.js';
import type { ServerMessage } from './protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeStt implements SttPort {
  cb?: SttCallbacks;
  connects = 0;
  audio: Buffer[] = [];
  closed = false;
  async connect(cb: SttCallbacks): Promise<SttConnection> {
    this.cb = cb;
    this.connects++;
    return {
      sendAudio: (pcm) => this.audio.push(pcm),
      endOfAudio: () => undefined,
      close: () => (this.closed = true),
    };
  }
}

class FakeLlm implements LlmPort {
  requests: LlmRequest[] = [];
  constructor(private readonly replies: string[][]) {}
  async *stream(req: LlmRequest): AsyncGenerator<string> {
    this.requests.push({ ...req, history: req.history.map((t) => ({ ...t })) });
    for (const delta of this.replies[this.requests.length - 1] ?? []) {
      await sleep(5);
      if (req.signal.aborted) return;
      yield delta;
    }
  }
}

class FakeTts implements TtsPort {
  readonly sampleRate = 24000;
  aborted = 0;
  constructor(private readonly chunkDelayMs = 5) {}
  async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    for (let i = 0; i < 3; i++) {
      await sleep(this.chunkDelayMs);
      if (signal.aborted) {
        this.aborted++;
        return;
      }
      yield Buffer.from(`${text}#${i}`);
    }
  }
}

function setup(replies: string[][], tts = new FakeTts()) {
  const stt = new FakeStt();
  const llm = new FakeLlm(replies);
  const events: (ServerMessage | { type: 'audio'; data: string })[] = [];
  const closeSpy = vi.fn<SessionTransport['close']>();
  const transport: SessionTransport = {
    sendJson: (m) => events.push(m),
    sendAudio: (pcm) => events.push({ type: 'audio', data: pcm.toString() }),
    close: closeSpy,
  };
  const session = new ConversationSession(
    transport,
    { stt, llm, tts },
    {
      systemPrompt: 'test',
      sttRetryDelaysMs: [1, 1, 1],
    },
  );
  return { session, stt, llm, tts, events, closeSpy };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await sleep(2);
  }
}

describe('ConversationSession', () => {
  it('turns a final transcript into an ordered voice reply', async () => {
    const { session, stt, events } = setup([
      [
        'I went there last summer',
        '. It was great! ',
        'Have you ever been to Samarkand?',
      ],
    ]);
    await session.start();
    session.handleAudio(Buffer.from('pcm'));
    expect(stt.audio).toHaveLength(1);

    stt.cb!.onInterim('I want to');
    stt.cb!.onFinal('I want to visit Samarkand.');
    await until(() => events.some((e) => e.type === 'tts_end'));

    const types = events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual([
      'ready',
      'transcript_interim',
      'transcript_final',
    ]);
    expect(types.indexOf('tts_start')).toBeLessThan(types.indexOf('audio'));
    expect(types.at(-1)).toBe('tts_end');

    const audio = events.flatMap((e) => (e.type === 'audio' ? [e.data] : []));
    expect(audio).toEqual([
      'I went there last summer.#0',
      'I went there last summer.#1',
      'I went there last summer.#2',
      'It was great! Have you ever been to Samarkand?#0',
      'It was great! Have you ever been to Samarkand?#1',
      'It was great! Have you ever been to Samarkand?#2',
    ]);
    session.close();
    expect(stt.closed).toBe(true);
  });

  it('barge-in stops the current reply and answers the new utterance', async () => {
    const { session, stt, llm, tts, events } = setup(
      [
        [
          'This is the first sentence of a long answer. ',
          'And this is the second one, still talking.',
        ],
        ['Sure, let us talk about something else.'],
      ],
      new FakeTts(30),
    );
    await session.start();
    stt.cb!.onFinal('Tell me a story.');
    await until(() => events.some((e) => e.type === 'tts_start'));

    stt.cb!.onFinal('Wait, stop.');
    const stopIdx = events.findIndex((e) => e.type === 'tts_stop');
    expect(stopIdx).toBeGreaterThan(-1);
    expect(events[stopIdx]).toEqual({ type: 'tts_stop', turnId: 1 });

    await until(() => events.some((e) => e.type === 'tts_end'));
    // No audio from the interrupted turn after tts_stop.
    const after = events
      .slice(stopIdx + 1)
      .flatMap((e) => (e.type === 'audio' ? [e.data] : []));
    expect(after.every((a) => a.startsWith('Sure'))).toBe(true);
    expect(tts.aborted).toBeGreaterThan(0);
    // The interrupted reply was never fully spoken, so both user utterances merge.
    expect(llm.requests[1].history).toEqual([
      { role: 'user', text: 'Tell me a story. Wait, stop.' },
    ]);
    session.close();
  });

  it('reconnects STT when the upstream session drops', async () => {
    const { session, stt, events } = setup([]);
    await session.start();
    stt.cb!.onUnexpectedClose('goAway');
    await until(() => stt.connects === 2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    session.close();
  });

  it('gives up when every new STT connection dies immediately', async () => {
    const { session, stt, events, closeSpy } = setup([]);
    await session.start();
    const failed = () => closeSpy.mock.calls.length > 0;
    // Each reconnect "succeeds" but drops right away (like a rejected API key).
    for (let i = 0; i < 6 && !failed(); i++) {
      const connects = stt.connects;
      stt.cb!.onUnexpectedClose('closed: 1007');
      await until(() => stt.connects > connects || failed());
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true });
    expect(closeSpy).toHaveBeenCalledWith(1011, 'stt unavailable');
    expect(stt.connects).toBeLessThanOrEqual(5);
    session.close();
  });

  it('answers ping and rejects unknown messages', async () => {
    const { session, events } = setup([]);
    await session.start();
    session.handleText('{"type":"ping"}');
    session.handleText('nope');
    expect(events.slice(1).map((e) => e.type)).toEqual(['pong', 'error']);
    session.close();
  });
});
