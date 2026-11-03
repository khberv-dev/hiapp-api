import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TimestampedEntity } from '../../../shared/entities/timestamped.entity.js';
import { Conversation } from './conversation.entity.js';

export enum TurnRole {
  User = 'user',
  Ai = 'ai',
}

/** One transcript line of a conversation. Order by `createdAt`. */
@Entity('turns')
@Index(['conversationId', 'createdAt'])
export class Turn extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  conversation: Conversation;

  @Column({ type: 'enum', enum: TurnRole })
  role: TurnRole;

  /** User: the final STT transcript. AI: the reply as heard (cut on barge-in). */
  @Column('text')
  text: string;
}
