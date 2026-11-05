import { Logger } from '@nestjs/common';
import type { SttCallbacks, SttConnection, SttPort } from './ai.types.js';
import { ProviderError } from './provider-error.js';
import { ResilientStt, type ResilientSttOptions } from './resilient-stt.js';

class FakeConn implements SttConnection {
  audio: string[] = [];
  ended = 0;
  closed = false;
  constructor(readonly cb: SttCallbacks) {}
  sendAudio(pcm: Buffer) {
    if (!this.closed) this.audio.push(pcm.toString());
  }
  endOfAudio() {
    this.ended++;
  }
  close() {
    this.closed = true;
  }
}

class FakeInner implements SttPort {
  conns: FakeConn[] = [];
  attempts = 0;
  /** Errors thrown by the next connect() calls, in order. */
  failures: Error[] = [];
  failAlways?: Error;
  async connect(cb: SttCallbacks): Promise<SttConnection> {
    this.attempts++;
    await Promise.resolve();
    const err = this.failures.shift() ?? this.failAlways;
    if (err) throw err;
    const conn = new FakeConn(cb);
    this.conns.push(conn);
    return conn;
  }
}

const quiet = { log: () => {}, warn: () => {} } as unknown as Logger;

function setup(opts: Partial<ResilientSttOptions> = {}) {
  const inner = new FakeInner();
  const stt = new ResilientStt(
    inner,
    {
      backoff: { baseMs: 1, maxMs: 2 },
      budgetMs: 1000,
      drainMs: 50,
      healthyAfterMs: 0,
      ...opts,
    },
    quiet,
  );
  const cb = {
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onUnexpectedClose: vi.fn(),
    onStatus: vi.fn(),
  };
  return { inner, stt, cb };
}

const pcm = (s: string) => Buffer.from(s);

describe('ResilientStt', () => {
  it('hands over make-before-break on goAway', async () => {
    const { inner, stt, cb } = setup();
    const conn = await stt.connect(cb);
    const [old] = inner.conns;
    conn.sendAudio(pcm('a'));

    old.cb.onGoAway!(5000);
    conn.sendAudio(pcm('b')); // still goes to the old one while connecting
    await vi.waitFor(() => expect(inner.conns).toHaveLength(2));
    const next = inner.conns[1];
    expect(old.closed).toBe(false); // the new one connected first
    expect(old.ended).toBe(1); // asked to finalize its pending utterance

    conn.sendAudio(pcm('c'));
    expect(old.audio).toEqual(['a', 'b']);
    expect(next.audio).toEqual(['c']);

    old.cb.onInterim('stale'); // dropped
    old.cb.onFinal('late final'); // still delivered
    expect(cb.onInterim).not.toHaveBeenCalled();
    expect(cb.onFinal).toHaveBeenCalledWith('late final');
    expect(old.closed).toBe(true); // closed once its final arrived

    next.cb.onFinal('new final');
    expect(cb.onFinal).toHaveBeenLastCalledWith('new final');
    expect(cb.onUnexpectedClose).not.toHaveBeenCalled();
    expect(cb.onStatus).not.toHaveBeenCalled();
    conn.close();
    expect(next.closed).toBe(true);
  });

  it('closes the old connection after drainMs when no final comes', async () => {
    const { inner, stt, cb } = setup({ drainMs: 300 });
    await stt.connect(cb);
    inner.conns[0].cb.onGoAway!();
    await vi.waitFor(() => expect(inner.conns).toHaveLength(2));
    expect(inner.conns[0].closed).toBe(false);
    await vi.waitFor(() => expect(inner.conns[0].closed).toBe(true));
    // A close event from the drained connection is not a failure.
    inner.conns[0].cb.onUnexpectedClose('closed: 1000');
    expect(cb.onUnexpectedClose).not.toHaveBeenCalled();
  });

  it('reconnects after a drop and replays the audio since the last final', async () => {
    const { inner, stt, cb } = setup();
    const conn = await stt.connect(cb);
    conn.sendAudio(pcm('old1'));
    inner.conns[0].cb.onFinal('done with that');
    conn.sendAudio(pcm('n1'));
    conn.sendAudio(pcm('n2'));

    inner.failures = [new Error('503 UNAVAILABLE'), new Error('fetch failed')];
    inner.conns[0].cb.onUnexpectedClose('closed: 1011 internal');
    expect(cb.onStatus).toHaveBeenCalledWith('reconnecting');
    conn.sendAudio(pcm('gap')); // spoken while reconnecting: not lost

    await vi.waitFor(() => expect(cb.onStatus).toHaveBeenLastCalledWith('ok'));
    expect(inner.attempts).toBe(4); // initial + 2 failures + success
    const next = inner.conns[1];
    expect(next.audio).toEqual(['n1', 'n2', 'gap']);
    conn.sendAudio(pcm('live'));
    expect(next.audio.at(-1)).toBe('live');
    expect(cb.onUnexpectedClose).not.toHaveBeenCalled();
    conn.close();
  });

  it('keeps at most replayBufferMs of audio for replay', async () => {
    // 1 ms = 32 bytes at 16 kHz s16le.
    const { inner, stt, cb } = setup({ replayBufferMs: 1 });
    const conn = await stt.connect(cb);
    conn.sendAudio(Buffer.alloc(40, 'a'));
    conn.sendAudio(Buffer.alloc(8, 'b'));
    inner.conns[0].cb.onUnexpectedClose('dropped');
    await vi.waitFor(() => expect(inner.conns).toHaveLength(2));
    expect(inner.conns[1].audio.join('')).toBe('a'.repeat(24) + 'b'.repeat(8));
    conn.close();
  });

  it('gives up exactly once when the budget is exhausted', async () => {
    const { inner, stt, cb } = setup({
      budgetMs: 30,
      backoff: { baseMs: 5, maxMs: 10 },
    });
    await stt.connect(cb);
    inner.failAlways = new Error('503 overloaded');
    inner.conns[0].cb.onUnexpectedClose('dropped');
    await vi.waitFor(() => expect(cb.onUnexpectedClose).toHaveBeenCalled());
    const attempts = inner.attempts;
    await new Promise((r) => setTimeout(r, 50));
    expect(cb.onUnexpectedClose).toHaveBeenCalledTimes(1);
    expect(inner.attempts).toBe(attempts); // stopped retrying
    expect(attempts).toBeGreaterThan(2);
  });

  it('does not retry an auth error', async () => {
    const { inner, stt, cb } = setup();
    await stt.connect(cb);
    inner.failAlways = new ProviderError('auth', 'gemini', 'API key not valid');
    inner.conns[0].cb.onUnexpectedClose('dropped');
    await vi.waitFor(() =>
      expect(cb.onUnexpectedClose).toHaveBeenCalledTimes(1),
    );
    expect(inner.attempts).toBe(2);
  });

  it('gives up at once when the connection is closed for a bad API key', async () => {
    const { inner, stt, cb } = setup();
    await stt.connect(cb);
    inner.conns[0].cb.onUnexpectedClose('closed: 1007 API key not valid.');
    expect(cb.onUnexpectedClose).toHaveBeenCalledTimes(1);
    expect(inner.attempts).toBe(1);
  });

  it('rejects the initial connect on an auth error without retrying', async () => {
    const { inner, stt, cb } = setup();
    inner.failAlways = new ProviderError('auth', 'gemini', 'bad key');
    await expect(stt.connect(cb)).rejects.toMatchObject({ kind: 'auth' });
    expect(inner.attempts).toBe(1);
  });

  it('retries the initial connect on transient errors', async () => {
    const { inner, stt, cb } = setup();
    inner.failures = [new Error('503 overloaded')];
    await stt.connect(cb);
    expect(inner.attempts).toBe(2);
  });

  it('stops after too many connections that die right away', async () => {
    const { inner, stt, cb } = setup({
      healthyAfterMs: 10_000,
      maxQuickFailures: 2,
    });
    await stt.connect(cb);
    for (let i = 0; i < 5 && !cb.onUnexpectedClose.mock.calls.length; i++) {
      const n = inner.conns.length;
      inner.conns[n - 1].cb.onUnexpectedClose('closed: 1011');
      await vi.waitFor(() =>
        expect(
          inner.conns.length > n || cb.onUnexpectedClose.mock.calls.length > 0,
        ).toBe(true),
      );
    }
    expect(cb.onUnexpectedClose).toHaveBeenCalledTimes(1);
    expect(inner.conns.length).toBe(3);
  });
});
