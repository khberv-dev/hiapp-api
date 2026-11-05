import type { LlmPort, LlmRequest, TtsPort } from './ai.types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { FallbackLlm } from './fallback-llm.js';
import { FallbackTts } from './fallback-tts.js';
import { ProviderError, type ProviderErrorKind } from './provider-error.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step =
  | { fail: ProviderErrorKind }
  | { hang: true }
  | { yield: string[]; thenFail?: ProviderErrorKind };

/** A port whose n-th call follows `steps[n]` (the last step repeats). */
class ScriptedLlm implements LlmPort {
  calls = 0;
  constructor(private readonly steps: Step[]) {}
  async *stream({ signal }: LlmRequest): AsyncGenerator<string> {
    const step = this.steps[Math.min(this.calls++, this.steps.length - 1)];
    await sleep(1);
    if ('fail' in step) throw new ProviderError(step.fail, 'fake', step.fail);
    if ('hang' in step) {
      await new Promise((r) => signal.addEventListener('abort', r));
      return;
    }
    for (const t of step.yield) {
      if (signal.aborted) return;
      yield t;
    }
    if (step.thenFail)
      throw new ProviderError(step.thenFail, 'fake', step.thenFail);
  }
}

class ScriptedTts implements TtsPort {
  readonly sampleRate = 24000;
  private readonly llm: ScriptedLlm;
  constructor(steps: Step[]) {
    this.llm = new ScriptedLlm(steps);
  }
  get calls() {
    return this.llm.calls;
  }
  async *synthesize(
    _text: string,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    for await (const t of this.llm.stream({
      systemPrompt: '',
      history: [],
      signal,
    }))
      yield Buffer.from(t);
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const req = (signal = new AbortController().signal, onServed?: () => void) => ({
  systemPrompt: 's',
  history: [],
  signal,
  onServed,
});

describe('FallbackLlm', () => {
  afterEach(() => vi.restoreAllMocks());

  const chain = (a: ScriptedLlm, b: ScriptedLlm, firstTokenMs = 2500) =>
    new FallbackLlm(
      [
        { name: 'a', port: a },
        { name: 'b', port: b },
      ],
      { firstTokenMs },
    );

  it('moves to the next model when the first misses its first-token deadline', async () => {
    const a = new ScriptedLlm([{ hang: true }]);
    const b = new ScriptedLlm([{ yield: ['hi'] }]);
    const served = vi.fn();
    const started = Date.now();
    const out = await collect(chain(a, b, 50).stream(req(undefined, served)));
    expect(out).toEqual(['hi']);
    expect(a.calls).toBe(1); // a timeout is not retried on the same model
    expect(served).toHaveBeenCalledWith('b');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('goes straight to the next model on 429', async () => {
    const random = vi.spyOn(Math, 'random');
    const a = new ScriptedLlm([{ fail: 'rate_limited' }]);
    const b = new ScriptedLlm([{ yield: ['ok'] }]);
    expect(await collect(chain(a, b).stream(req()))).toEqual(['ok']);
    expect(a.calls).toBe(1);
    expect(random).not.toHaveBeenCalled(); // no backoff sleep
  });

  it('retries an overloaded model once before falling back', async () => {
    const a = new ScriptedLlm([
      { fail: 'overloaded' },
      { yield: ['second try'] },
    ]);
    const b = new ScriptedLlm([{ yield: ['b'] }]);
    expect(await collect(chain(a, b).stream(req()))).toEqual(['second try']);
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(0);
  });

  it('throws a bad request immediately', async () => {
    const a = new ScriptedLlm([{ fail: 'bad_request' }]);
    const b = new ScriptedLlm([{ yield: ['b'] }]);
    await expect(collect(chain(a, b).stream(req()))).rejects.toMatchObject({
      kind: 'bad_request',
    });
    expect(b.calls).toBe(0);
  });

  it('rethrows an error after the first token', async () => {
    const a = new ScriptedLlm([{ yield: ['part'], thenFail: 'overloaded' }]);
    const b = new ScriptedLlm([{ yield: ['b'] }]);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const t of chain(a, b).stream(req())) seen.push(t);
      })(),
    ).rejects.toMatchObject({ kind: 'overloaded' });
    expect(seen).toEqual(['part']);
    expect(b.calls).toBe(0);
  });

  it('returns quietly when the caller aborts during the deadline', async () => {
    const a = new ScriptedLlm([{ hang: true }]);
    const b = new ScriptedLlm([{ yield: ['b'] }]);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    expect(await collect(chain(a, b, 1000).stream(req(ctl.signal)))).toEqual(
      [],
    );
    expect(b.calls).toBe(0);
  });

  it('skips an entry whose circuit is open', async () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i++) breaker.failure();
    const a = new ScriptedLlm([{ yield: ['a'] }]);
    const b = new ScriptedLlm([{ yield: ['b'] }]);
    const llm = new FallbackLlm(
      [
        { name: 'a', port: a, breaker },
        { name: 'b', port: b },
      ],
      { firstTokenMs: 1000 },
    );
    expect(await collect(llm.stream(req()))).toEqual(['b']);
    expect(a.calls).toBe(0);
  });
});

describe('FallbackTts', () => {
  const tts = (port: TtsPort, retries = 2, firstChunkMs = 2500) =>
    new FallbackTts([{ name: 'gemini:tts', port }], { retries, firstChunkMs });
  const text = (bufs: Buffer[]) => bufs.map((b) => b.toString());

  beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0)); // no backoff wait
  afterEach(() => vi.restoreAllMocks());

  it('retries 503s and delivers the audio', async () => {
    const port = new ScriptedTts([
      { fail: 'overloaded' },
      { fail: 'overloaded' },
      { yield: ['pcm1', 'pcm2'] },
    ]);
    const served = vi.fn();
    const out = await collect(
      tts(port).synthesize('Hi.', new AbortController().signal, served),
    );
    expect(text(out)).toEqual(['pcm1', 'pcm2']);
    expect(port.calls).toBe(3);
    expect(served).toHaveBeenCalledWith('gemini:tts');
  });

  it('gives up after the configured retries', async () => {
    const port = new ScriptedTts([{ fail: 'overloaded' }]);
    await expect(
      collect(tts(port, 2).synthesize('Hi.', new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'overloaded' });
    expect(port.calls).toBe(3);
  });

  it('retries when no chunk arrives in time', async () => {
    const port = new ScriptedTts([{ hang: true }, { yield: ['late'] }]);
    const out = await collect(
      tts(port, 2, 30).synthesize('Hi.', new AbortController().signal),
    );
    expect(text(out)).toEqual(['late']);
  });

  it('does not retry a 429 whose retry hint is longer than the cap', async () => {
    const daily = new ProviderError(
      'rate_limited',
      'p',
      'retry in 2h',
      7_200_000,
    );
    let calls = 0;
    const port: TtsPort = {
      sampleRate: 24000,
      // eslint-disable-next-line require-yield
      async *synthesize() {
        calls++;
        throw daily;
      },
    };
    const breaker = new CircuitBreaker();
    const chain = new FallbackTts([{ name: 'p', port, breaker }], {
      retries: 2,
      firstChunkMs: 1000,
    });
    await expect(
      collect(chain.synthesize('Hi.', new AbortController().signal)),
    ).rejects.toBe(daily);
    expect(calls).toBe(1);
    expect(breaker.isOpen).toBe(true);
  });

  it('does not retry a 400', async () => {
    const port = new ScriptedTts([{ fail: 'bad_request' }, { yield: ['x'] }]);
    await expect(
      collect(tts(port).synthesize('Hi.', new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(port.calls).toBe(1);
  });

  it('rethrows a failure after the first chunk', async () => {
    const port = new ScriptedTts([
      { yield: ['half'], thenFail: 'overloaded' },
      { yield: ['again'] },
    ]);
    await expect(
      collect(tts(port).synthesize('Hi.', new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'overloaded' });
    expect(port.calls).toBe(1);
  });

  it('requires one sample rate across the chain', () => {
    const a = new ScriptedTts([]);
    const b = { sampleRate: 16000, synthesize: a.synthesize.bind(a) };
    expect(
      () =>
        new FallbackTts(
          [
            { name: 'a', port: a },
            { name: 'b', port: b },
          ],
          { retries: 0, firstChunkMs: 100 },
        ),
    ).toThrow(/16000 Hz/);
  });
});
