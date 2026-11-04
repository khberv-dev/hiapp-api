import { type BeforeApplicationShutdown, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { type RawData, WebSocket } from 'ws';
import {
  LLM,
  type LlmPort,
  STT,
  type SttPort,
  TTS,
  type TtsPort,
} from '../ai/ai.types.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { SubscriptionService } from '../subscription/subscription.service.js';
import { UserService } from '../user/user.service.js';
import {
  ConversationService,
  HEARTBEAT_SECONDS,
} from './conversation.service.js';
import { ConversationSession } from './conversation.session.js';
import { TurnRole } from './entities/turn.entity.js';
import { DEFAULT_SYSTEM_PROMPT } from './persona.js';
import { CloseCode, type ServerMessage } from './protocol.js';

interface ActiveConnection {
  userId: string;
  conversationId: string;
  session: ConversationSession;
  /** Auto-disconnect when the daily allowance runs out. */
  limitTimer: NodeJS.Timeout;
  heartbeat: NodeJS.Timeout;
  /** Turn inserts, chained so they're stored in order. */
  writes: Promise<void>;
}

const ROLES = { user: TurnRole.User, ai: TurnRole.Ai } as const;

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Access token from `?token=` or an `Authorization: Bearer` header. */
function extractToken(request: IncomingMessage): string | null {
  const fromQuery = new URL(
    request.url ?? '/',
    'http://localhost',
  ).searchParams.get('token');
  if (fromQuery) return fromQuery;
  const [type, token] = request.headers.authorization?.split(' ') ?? [];
  return type === 'Bearer' && token ? token : null;
}

/**
 * ws://host/v1/conversation?token=<accessToken>
 * Binary frames carry audio, text frames carry JSON control.
 *
 * Each connection is recorded as a `Conversation` with its `Turn`s, and is
 * limited by the user's remaining daily allowance (DAILY_LIMIT_SECONDS).
 * One live connection per user: a new one replaces the old one.
 */
@WebSocketGateway({ path: '/v1/conversation', maxPayload: 64 * 1024 })
export class ConversationGateway
  implements OnGatewayConnection, OnGatewayDisconnect, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ConversationGateway.name);
  private readonly connections = new Map<WebSocket, ActiveConnection>();
  private readonly clientByUser = new Map<string, WebSocket>();
  /** For users without a current subscription. */
  private readonly freeDailyLimitSec: number;

  constructor(
    @Inject(STT) private readonly stt: SttPort,
    @Inject(LLM) private readonly llm: LlmPort,
    @Inject(TTS) private readonly tts: TtsPort,
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly conversationService: ConversationService,
    private readonly subscriptionService: SubscriptionService,
    config: ConfigService,
  ) {
    this.freeDailyLimitSec = Number(config.getOrThrow('DAILY_LIMIT_SECONDS'));
    if (
      !Number.isFinite(this.freeDailyLimitSec) ||
      this.freeDailyLimitSec < 0
    ) {
      throw new Error('DAILY_LIMIT_SECONDS must be a non-negative number');
    }
  }

  async handleConnection(
    client: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    const send = (msg: ServerMessage) => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(msg));
    };
    const limitReached = () => {
      send({ type: 'limit_reached' });
      client.close(CloseCode.LimitReached, 'daily limit reached');
    };

    try {
      const userId = await this.authenticate(request);
      if (!userId) {
        client.close(CloseCode.Unauthorized, 'unauthorized');
        return;
      }

      // One live conversation per user, otherwise parallel connections
      // could each spend the full remaining allowance.
      const previous = this.clientByUser.get(userId);
      if (previous) {
        await this.release(previous);
        previous.close(CloseCode.Replaced, 'replaced by a new connection');
      }

      const [usedSec, dailyLimitSec] = await Promise.all([
        this.conversationService.usedSecondsToday(userId),
        this.dailyLimitFor(userId),
      ]);
      const remainingSec = Math.floor(dailyLimitSec - usedSec);
      if (remainingSec <= 0) {
        limitReached();
        return;
      }

      const conversation = await this.conversationService.start(userId);
      // The client may have left while we were authenticating / saving.
      if (client.readyState !== WebSocket.OPEN) {
        await this.conversationService.end(conversation.id);
        return;
      }

      const connection = {
        userId,
        conversationId: conversation.id,
        writes: Promise.resolve(),
      } as ActiveConnection;
      connection.session = new ConversationSession(
        {
          sendJson: send,
          sendAudio: (pcm) => {
            if (client.readyState === WebSocket.OPEN)
              client.send(pcm, { binary: true });
          },
          close: (code, reason) => client.close(code, reason),
        },
        { stt: this.stt, llm: this.llm, tts: this.tts },
        {
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          remainingSec,
          onTurn: (role, text) => this.saveTurn(connection, ROLES[role], text),
        },
      );
      connection.limitTimer = setTimeout(limitReached, remainingSec * 1000);
      connection.heartbeat = setInterval(() => {
        this.conversationService
          .touch(conversation.id)
          .catch((err: unknown) => {
            this.logger.warn(
              `Heartbeat failed for ${conversation.id}: ${String(err)}`,
            );
          });
      }, HEARTBEAT_SECONDS * 1000);

      this.connections.set(client, connection);
      this.clientByUser.set(userId, client);

      client.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) connection.session.handleAudio(toBuffer(data));
        else connection.session.handleText(toBuffer(data).toString('utf8'));
      });

      await connection.session.start();
    } catch (err) {
      this.logger.error(`Failed to start conversation: ${String(err)}`);
      send({
        type: 'error',
        message: 'failed to start the conversation',
        retryable: true,
      });
      client.close(CloseCode.InternalError, 'start failed');
    }
  }

  handleDisconnect(client: WebSocket): void {
    void this.release(client);
  }

  /** Records `endedAt` for conversations still open when the server stops. */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.connections.keys()].map((client) => this.release(client)),
    );
  }

  /**
   * Stops a connection's session and timers (cancelling the auto-disconnect),
   * flushes its pending turn writes and marks the conversation ended.
   */
  private async release(client: WebSocket): Promise<void> {
    const connection = this.connections.get(client);
    if (!connection) return;
    this.connections.delete(client);
    if (this.clientByUser.get(connection.userId) === client) {
      this.clientByUser.delete(connection.userId);
    }

    clearTimeout(connection.limitTimer);
    clearInterval(connection.heartbeat);
    connection.session.close(); // may record the interrupted AI reply
    await connection.writes;
    try {
      await this.conversationService.end(connection.conversationId);
    } catch (err) {
      this.logger.error(
        `Failed to end conversation ${connection.conversationId}: ${String(err)}`,
      );
    }
  }

  private saveTurn(
    connection: ActiveConnection,
    role: TurnRole,
    text: string,
  ): void {
    connection.writes = connection.writes
      .then(() =>
        this.conversationService.addTurn(connection.conversationId, role, text),
      )
      .catch((err: unknown) => {
        this.logger.error(
          `Failed to save ${role} turn of ${connection.conversationId}: ${String(err)}`,
        );
      });
  }

  /**
   * The current subscription's plan limit, never below the free limit
   * (a subscription should only ever add speaking time).
   */
  private async dailyLimitFor(userId: string): Promise<number> {
    const subscription =
      await this.subscriptionService.findCurrentByUser(userId);
    return Math.max(
      this.freeDailyLimitSec,
      subscription?.plan.dailyLimitSeconds ?? 0,
    );
  }

  /** Returns the user id for a valid token of an existing user, else null. */
  private async authenticate(request: IncomingMessage): Promise<string | null> {
    const token = extractToken(request);
    if (!token) return null;
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      return null;
    }
    const user = await this.userService.findById(payload.sub);
    return user?.id ?? null;
  }
}
