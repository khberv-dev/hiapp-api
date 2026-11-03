import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Conversation } from './entities/conversation.entity.js';
import { Turn, TurnRole } from './entities/turn.entity.js';

/**
 * Live conversations bump `updatedAt` this often. Usage of a conversation
 * with no `endedAt` is counted up to `updatedAt + HEARTBEAT`, so one left
 * open by a crash stops counting instead of growing forever.
 */
export const HEARTBEAT_SECONDS = 30;

@Injectable()
export class ConversationService {
  private readonly timezone: string;

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Turn)
    private readonly turnRepository: Repository<Turn>,
    config: ConfigService,
  ) {
    this.timezone = config.get<string>('USAGE_TIMEZONE') || 'UTC';
  }

  start(userId: string): Promise<Conversation> {
    return this.conversationRepository.save(
      this.conversationRepository.create({ userId, startedAt: new Date() }),
    );
  }

  /** Idempotent: only the first call sets `endedAt`. */
  async end(id: string): Promise<void> {
    await this.conversationRepository.update(
      { id, endedAt: IsNull() },
      { endedAt: new Date() },
    );
  }

  /** Heartbeat for a live conversation (see HEARTBEAT_SECONDS). */
  async touch(id: string): Promise<void> {
    await this.conversationRepository.update(
      { id, endedAt: IsNull() },
      { updatedAt: new Date() },
    );
  }

  async addTurn(
    conversationId: string,
    role: TurnRole,
    text: string,
  ): Promise<void> {
    await this.turnRepository.insert({ conversationId, role, text });
  }

  /**
   * Seconds of conversation the user has had "today" (calendar day in
   * USAGE_TIMEZONE). Conversations crossing midnight count only the part
   * after it; live ones count up to now (via the heartbeat).
   */
  async usedSecondsToday(userId: string): Promise<number> {
    const rows: { used: number }[] = await this.conversationRepository.query(
      `WITH bounds AS (
         SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start
       )
       SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM
         LEAST(now(), COALESCE(c.ended_at, c.updated_at + make_interval(secs => $3)))
         - GREATEST(c.started_at, b.day_start)
       ))), 0)::float8 AS used
       FROM conversations c CROSS JOIN bounds b
       WHERE c.user_id = $1 AND (c.ended_at IS NULL OR c.ended_at > b.day_start)`,
      [userId, this.timezone, HEARTBEAT_SECONDS],
    );
    return rows[0]?.used ?? 0;
  }
}
