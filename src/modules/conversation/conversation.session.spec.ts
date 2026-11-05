import type {
  ChatTurn,
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
  constructor(
    private readonly chunkDelayMs = 5,
    /** Sentences containing this text fail (after all port retries). */
    private readonly failOn?: string,
  ) {}
  async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    if (this.failOn && text.includes(this.failOn)) {
      await sleep(this.chunkDelayMs);
      throw new Error('503 overloaded');
    }
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

function setup(
  replies: string[][],
  tts = new FakeTts(),
  extra: {
    initialHistory?: ChatTurn[];
    resumed?: boolean;
    sendTurnMetrics?: boolean;
  } = {},
) {
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
      conversationId: 'conv-1',
      ...extra,
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
    expect(events[0]).toEqual({
      type: 'ready',
      conversationId: 'conv-1',
      remainingSec: undefined,
    });
    expect(types.slice(1, 3)).toEqual([
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

  it('logs per-turn timing marks in pipeline order', async () => {
    const { session, stt, events } = setup(
      [['Sure, that is a lovely idea. ', 'Where would you like to go?']],
      new FakeTts(),
      { sendTurnMetrics: true },
    );
    await session.start();
    session.handleText('{"type":"end_of_audio"}'); // stale: no utterance pending
    stt.cb!.onInterim('Let us');
    session.handleText('{"type":"end_of_audio"}');
    stt.cb!.onFinal('Let us travel.');
    await until(() => events.some((e) => e.type === 'turn_metrics'));

    const metrics = events.find((e) => e.type === 'turn_metrics') as Record<
      string,
      unknown
    >;
    expect(metrics).toMatchObject({ turnId: 1, conversationId: 'conv-1' });
    expect(typeof metrics.finalLagMs).toBe('number');
    const order = [
      'final',
      'llmFirstToken',
      'firstSentence',
      'ttsFirstChunk',
      'firstAudioSent',
      'llmDone',
      'ttsEnd',
    ];
    const times = order.map((m) => metrics[m] as number);
    times.forEach((t, i) => expect(typeof t, order[i]).toBe('number'));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(JSON.stringify(metrics)).not.toContain('travel'); // no transcript text
    session.close();
  });

  it('skips a sentence whose TTS keeps failing and speaks the rest', async () => {
    const { session, stt, events } = setup(
      [
        [
          'This is the first sentence here. ',
          'The second sentence is broken. ',
          'And here is the third sentence.',
        ],
      ],
      new FakeTts(5, 'broken'),
    );
    await session.start();
    stt.cb!.onFinal('Talk to me.');
    await until(() => events.some((e) => e.type === 'tts_end'));

    const audio = events.flatMap((e) => (e.type === 'audio' ? [e.data] : []));
    expect(audio.some((a) => a.startsWith('This is the first'))).toBe(true);
    expect(audio.some((a) => a.startsWith('And here is the third'))).toBe(true);
    expect(audio.some((a) => a.includes('broken'))).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    session.close();
  });

  it('fails the turn only when no sentence produced audio', async () => {
    const { session, stt, events } = setup(
      [['Everything here is broken today.']],
      new FakeTts(5, 'broken'),
    );
    await session.start();
    stt.cb!.onFinal('Hello?');
    await until(() => events.some((e) => e.type === 'error'));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: 'failed to generate a reply',
    });
    expect(events.some((e) => e.type === 'tts_end')).toBe(false);
    session.close();
  });

  it('relays STT status and closes with 1011 once STT gives up', async () => {
    const { session, stt, events, closeSpy } = setup([
      ['A long reply that is still being generated when STT dies.'],
    ]);
    await session.start();
    stt.cb!.onStatus!('reconnecting');
    stt.cb!.onStatus!('ok');
    expect(events.slice(1)).toEqual([
      { type: 'status', stt: 'reconnecting' },
      { type: 'status', stt: 'ok' },
    ]);

    stt.cb!.onUnexpectedClose('budget exhausted');
    expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true });
    expect(closeSpy).toHaveBeenCalledWith(1011, 'stt unavailable');
    expect(stt.closed).toBe(false); // the port closed itself already
    stt.cb!.onFinal('ignored after close');
    expect(events.some((e) => e.type === 'transcript_final')).toBe(false);
  });

  it('continues a resumed conversation with its earlier turns', async () => {
    const initialHistory: ChatTurn[] = [
      { role: 'user', text: 'I like tea.' },
      { role: 'assistant', text: 'Nice! Green or black?' },
    ];
    const { session, stt, llm, events } = setup(
      [['Green tea is very healthy indeed.']],
      new FakeTts(),
      { initialHistory, resumed: true },
    );
    await session.start();
    expect(events[0]).toMatchObject({ type: 'ready', resumed: true });
    stt.cb!.onFinal('Green.');
    await until(() => events.some((e) => e.type === 'tts_end'));
    expect(llm.requests[0].history).toEqual([
      ...initialHistory,
      { role: 'user', text: 'Green.' },
    ]);
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
