import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { WebSocket } from 'ws';
import type {
  LlmPort,
  SttCallbacks,
  SttConnection,
  SttPort,
  TtsPort,
} from '../ai/ai.types.js';
import type { UserService } from '../user/user.service.js';
import { ConversationGateway } from './conversation.gateway.js';
import type { ConversationService } from './conversation.service.js';

class FakeClient extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  send = (data: unknown) => {
    if (typeof data === 'string') this.sent.push(data);
  };
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = WebSocket.CLOSED;
  });
  messages() {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
}

const asWs = (c: FakeClient) => c as unknown as WebSocket;
const request = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers }) as unknown as IncomingMessage;
const withToken = (token = 'good') =>
  request(`/v1/conversation?token=${token}`);

function setup({ dailyLimit = 600, usedToday = 0 } = {}) {
  let sttCallbacks: SttCallbacks | undefined;
  const sttClose = vi.fn();
  const stt: SttPort = {
    connect: (cb) => {
      sttCallbacks = cb;
      return Promise.resolve<SttConnection>({
        sendAudio: vi.fn(),
        endOfAudio: vi.fn(),
        close: sttClose,
      });
    },
  };
  const llm: LlmPort = {
    async *stream() {
      yield 'Nice to meet you, how are you doing today?';
    },
  };
  const tts: TtsPort = {
    sampleRate: 24000,
    async *synthesize() {
      yield Buffer.from('pcm');
    },
  };
  const jwt = {
    verifyAsync: vi.fn((token: string) =>
      token.startsWith('good')
        ? Promise.resolve({ sub: token === 'good2' ? 'user-2' : 'user-1' })
        : Promise.reject(new Error('bad')),
    ),
  };
  const users = {
    findById: vi.fn((id: string) => Promise.resolve({ id })),
  };
  let ids = 0;
  const conversations = {
    usedSecondsToday: vi.fn(() => Promise.resolve(usedToday)),
    start: vi.fn(() => Promise.resolve({ id: `conv-${++ids}` })),
    end: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve()),
    addTurn: vi.fn(() => Promise.resolve()),
  };
  const config = {
    getOrThrow: () => String(dailyLimit),
  } as unknown as ConfigService;
  const gateway = new ConversationGateway(
    stt,
    llm,
    tts,
    jwt as unknown as JwtService,
    users as unknown as UserService,
    conversations as unknown as ConversationService,
    config,
  );
  return { gateway, conversations, sttClose, stt: () => sttCallbacks! };
}

describe('ConversationGateway', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects connections without a valid token with 4401', async () => {
    const { gateway, conversations } = setup();
    for (const req of [request('/v1/conversation'), withToken('bad')]) {
      const client = new FakeClient();
      await gateway.handleConnection(asWs(client), req);
      expect(client.close).toHaveBeenCalledWith(4401, 'unauthorized');
    }
    expect(conversations.start).not.toHaveBeenCalled();
  });

  it('records a conversation from connect to disconnect', async () => {
    const { gateway, conversations, sttClose } = setup({ usedToday: 100.4 });
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());

    expect(conversations.start).toHaveBeenCalledWith('user-1');
    expect(client.messages()).toContainEqual({
      type: 'ready',
      remainingSec: 499,
    });

    gateway.handleDisconnect(asWs(client));
    await vi.waitFor(() =>
      expect(conversations.end).toHaveBeenCalledWith('conv-1'),
    );
    expect(sttClose).toHaveBeenCalled();
  });

  it('accepts an Authorization header and ends open conversations on shutdown', async () => {
    const { gateway, conversations } = setup();
    const client = new FakeClient();
    await gateway.handleConnection(
      asWs(client),
      request('/v1/conversation', { authorization: 'Bearer good' }),
    );
    expect(conversations.start).toHaveBeenCalledWith('user-1');

    await gateway.beforeApplicationShutdown();
    expect(conversations.end).toHaveBeenCalledWith('conv-1');
  });

  it('refuses the connection when the daily allowance is used up', async () => {
    const { gateway, conversations } = setup({
      dailyLimit: 600,
      usedToday: 600,
    });
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());

    expect(client.messages()).toEqual([{ type: 'limit_reached' }]);
    expect(client.close).toHaveBeenCalledWith(4403, 'daily limit reached');
    expect(conversations.start).not.toHaveBeenCalled();
  });

  it('disconnects automatically when the remaining allowance runs out', async () => {
    vi.useFakeTimers();
    const { gateway } = setup({ dailyLimit: 600, usedToday: 590 });
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());

    vi.advanceTimersByTime(9_999);
    expect(client.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(client.messages().at(-1)).toEqual({ type: 'limit_reached' });
    expect(client.close).toHaveBeenCalledWith(4403, 'daily limit reached');
  });

  it('cancels the auto-disconnect when the client disconnects first', async () => {
    vi.useFakeTimers();
    const { gateway, conversations } = setup({
      dailyLimit: 600,
      usedToday: 590,
    });
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());

    gateway.handleDisconnect(asWs(client));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.messages().some((m) => m.type === 'limit_reached')).toBe(
      false,
    );
    expect(conversations.end).toHaveBeenCalledWith('conv-1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('saves user and AI turns in order', async () => {
    const { gateway, conversations, stt } = setup();
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());

    stt().onFinal('Hello, my name is Nexus.');
    await vi.waitFor(() =>
      expect(conversations.addTurn).toHaveBeenCalledTimes(2),
    );
    expect(conversations.addTurn.mock.calls).toEqual([
      ['conv-1', 'user', 'Hello, my name is Nexus.'],
      ['conv-1', 'ai', 'Nice to meet you, how are you doing today?'],
    ]);
    gateway.handleDisconnect(asWs(client));
  });

  it('replaces an older connection of the same user', async () => {
    const { gateway, conversations } = setup();
    const first = new FakeClient();
    const other = new FakeClient();
    const second = new FakeClient();
    await gateway.handleConnection(asWs(first), withToken());
    await gateway.handleConnection(asWs(other), withToken('good2'));
    await gateway.handleConnection(asWs(second), withToken());

    expect(first.close).toHaveBeenCalledWith(
      4409,
      'replaced by a new connection',
    );
    expect(conversations.end).toHaveBeenCalledWith('conv-1');
    expect(other.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    await gateway.beforeApplicationShutdown();
  });

  it('ends the conversation right away if the client left during setup', async () => {
    const { gateway, conversations } = setup();
    const client = new FakeClient();
    conversations.start.mockImplementationOnce(() => {
      client.readyState = WebSocket.CLOSED;
      return Promise.resolve({ id: 'conv-x' });
    });
    await gateway.handleConnection(asWs(client), withToken());
    expect(conversations.end).toHaveBeenCalledWith('conv-x');
    expect(client.sent).toEqual([]);
  });
});
