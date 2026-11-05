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
import type { SubscriptionService } from '../subscription/subscription.service.js';
import type { UserService } from '../user/user.service.js';
import { ConversationGateway } from './conversation.gateway.js';
import type { ConversationService } from './conversation.service.js';

class FakeClient extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  send = (data: unknown) => {
    if (typeof data === 'string') this.sent.push(data);
  };
  bufferedAmount = 0;
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = WebSocket.CLOSED;
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });
  ping = vi.fn();
  messages() {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
}

const asWs = (c: FakeClient) => c as unknown as WebSocket;
const request = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers }) as unknown as IncomingMessage;
const withToken = (token = 'good', query = '') =>
  request(`/v1/conversation${query}`, { authorization: `Bearer ${token}` });

function setup({
  dailyLimit = 600,
  usedToday = 0,
  planLimit = undefined as number | undefined,
  resumable = null as { id: string } | null,
} = {}) {
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
    findResumable: vi.fn(() => Promise.resolve(resumable)),
    reopen: vi.fn(() => Promise.resolve()),
    recentTurns: vi.fn(() =>
      Promise.resolve([
        { role: 'user', text: 'I like tea.' },
        { role: 'assistant', text: 'Green or black?' },
      ]),
    ),
  };
  const subscriptions = {
    findCurrentByUser: vi.fn(() =>
      Promise.resolve(
        planLimit === undefined
          ? null
          : { plan: { dailyLimitSeconds: planLimit } },
      ),
    ),
  };
  const config = {
    getOrThrow: () => String(dailyLimit),
    get: () => undefined,
  } as unknown as ConfigService;
  const gateway = new ConversationGateway(
    stt,
    llm,
    tts,
    jwt as unknown as JwtService,
    users as unknown as UserService,
    conversations as unknown as ConversationService,
    subscriptions as unknown as SubscriptionService,
    config,
  );
  return {
    gateway,
    conversations,
    sttClose,
    llm,
    stt: () => sttCallbacks!,
  };
}

describe('ConversationGateway', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects connections without a valid header token with 4401', async () => {
    const { gateway, conversations } = setup();
    for (const req of [
      request('/v1/conversation'),
      request('/v1/conversation?token=good'), // query tokens are not accepted
      withToken('bad'),
    ]) {
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
      conversationId: 'conv-1',
    });

    gateway.handleDisconnect(asWs(client));
    await vi.waitFor(() =>
      expect(conversations.end).toHaveBeenCalledWith('conv-1'),
    );
    expect(sttClose).toHaveBeenCalled();
  });

  it('ends open conversations on shutdown', async () => {
    const { gateway, conversations } = setup();
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());
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

  it("uses the current subscription's plan limit", async () => {
    const { gateway } = setup({
      dailyLimit: 600,
      usedToday: 900,
      planLimit: 3600,
    });
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());
    expect(client.messages()).toContainEqual({
      type: 'ready',
      remainingSec: 2700,
      conversationId: 'conv-1',
    });
    await gateway.beforeApplicationShutdown();
  });

  it('never lets a plan lower the free limit', async () => {
    const { gateway } = setup({ dailyLimit: 600, usedToday: 0, planLimit: 60 });
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());
    expect(client.messages()).toContainEqual({
      type: 'ready',
      remainingSec: 600,
      conversationId: 'conv-1',
    });
    await gateway.beforeApplicationShutdown();
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

  it('resumes a recent conversation with its turns as context', async () => {
    const id = '7f1d9a52-3c4b-4e8a-9a0e-2b6c1d3e4f50';
    const { gateway, conversations, stt } = setup({ resumable: { id } });
    const client = new FakeClient();
    await gateway.handleConnection(
      asWs(client),
      withToken('good', `?resume=${id}`),
    );

    expect(conversations.findResumable).toHaveBeenCalledWith('user-1', id, 120);
    expect(conversations.reopen).toHaveBeenCalledWith(id);
    expect(conversations.start).not.toHaveBeenCalled();
    expect(client.messages()).toContainEqual({
      type: 'ready',
      remainingSec: 600,
      conversationId: id,
      resumed: true,
    });
    stt().onFinal('Green, please.');
    await vi.waitFor(() =>
      expect(conversations.addTurn).toHaveBeenCalledWith(
        id,
        'user',
        'Green, please.',
      ),
    );
    await gateway.beforeApplicationShutdown();
    expect(conversations.end).toHaveBeenCalledWith(id);
  });

  it('starts a new conversation when the resume id is not resumable', async () => {
    // Another user's id or an expired one: findResumable returns null.
    const { gateway, conversations } = setup({ resumable: null });
    const client = new FakeClient();
    await gateway.handleConnection(
      asWs(client),
      withToken('good', '?resume=not-mine'),
    );
    expect(conversations.reopen).not.toHaveBeenCalled();
    expect(conversations.start).toHaveBeenCalledWith('user-1');
    expect(client.messages()).toContainEqual({
      type: 'ready',
      remainingSec: 600,
      conversationId: 'conv-1',
    });
    await gateway.beforeApplicationShutdown();
  });

  it('never fails the connect because of a broken resume lookup', async () => {
    const { gateway, conversations } = setup();
    conversations.findResumable.mockImplementationOnce(() =>
      Promise.reject(new Error('db down')),
    );
    const client = new FakeClient();
    await gateway.handleConnection(
      asWs(client),
      withToken('good', '?resume=x'),
    );
    expect(conversations.start).toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    await gateway.beforeApplicationShutdown();
  });

  it('terminates a peer that stops answering pings', async () => {
    vi.useFakeTimers();
    const { gateway, conversations } = setup();
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());

    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.ping).toHaveBeenCalledTimes(1);
    client.emit('pong');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000); // no pong this time
    expect(client.terminate).toHaveBeenCalled();

    gateway.handleDisconnect(asWs(client));
    await vi.advanceTimersByTimeAsync(0);
    expect(conversations.end).toHaveBeenCalledWith('conv-1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives exceptions thrown while handling a message', async () => {
    const { gateway } = setup();
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());
    // A text frame that makes the session throw must not escape the listener.
    const session = (
      gateway as unknown as {
        connections: Map<unknown, { session: { handleText(s: string): void } }>;
      }
    ).connections.get(client)!.session;
    session.handleText = () => {
      throw new Error('boom');
    };
    expect(() =>
      client.emit('message', Buffer.from('{}'), false),
    ).not.toThrow();
    await gateway.beforeApplicationShutdown();
  });

  it('terminates a client that stops reading audio', async () => {
    const { gateway, stt } = setup();
    const client = new FakeClient();
    await gateway.handleConnection(asWs(client), withToken());
    client.bufferedAmount = 2_000_000;
    stt().onFinal('Hello there, how are you?');
    await vi.waitFor(() => expect(client.terminate).toHaveBeenCalledTimes(1));
    await gateway.beforeApplicationShutdown();
  });
});
