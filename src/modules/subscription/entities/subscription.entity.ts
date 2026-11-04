import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Plan } from '../../plan/entities/plan.entity.js';
import { User } from '../../user/entities/user.entity.js';

/**
 * A user's access to a plan. Created inactive with no dates when the user
 * requests it; activated (dates set) by a successful payment of its invoice.
 */
@Entity('subscriptions')
@Index(['userId', 'endDate'])
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  planId: string;

  // RESTRICT: a plan with subscriptions can't be deleted (keeps billing history).
  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  plan: Plan;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  /** True once paid. */
  @Column({ default: false })
  isActive: boolean;

  /** Set when paid. In the future if the user renewed before the previous subscription ended. */
  @Column({ type: 'timestamptz', nullable: true })
  startDate: Date | null;

  /** Set when paid: `startDate + plan.durationDays`. */
  @Column({ type: 'timestamptz', nullable: true })
  endDate: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
