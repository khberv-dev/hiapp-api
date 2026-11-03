import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TimestampedEntity } from '../../../shared/entities/timestamped.entity.js';
import { User } from '../../user/entities/user.entity.js';

/** One voice conversation = one authenticated WebSocket connection. */
@Entity('conversations')
@Index(['userId', 'startedAt'])
export class Conversation extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  /** When the client connected. */
  @Column({ type: 'timestamptz' })
  startedAt: Date;

  /** When the client disconnected. Null while live, or if the server crashed mid-conversation. */
  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;
}
