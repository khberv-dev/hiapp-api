import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity.js';

export enum TurnRole {
  User = 'user',
  Ai = 'ai',
}

/** One transcript line of a conversation. Order by `createdAt`. */
@Entity('turns')
@Index(['conversationId', 'createdAt'])
export class Turn {
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
