import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numberTransformer } from '../../../shared/entities/transformers.js';

@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  /** In UZS (so'm). Charged as `price × 100` tiyin. */
  @Column('numeric', {
    precision: 12,
    scale: 2,
    transformer: numberTransformer,
  })
  price: number;

  /** How long a paid subscription to this plan lasts. */
  @Column('int')
  durationDays: number;

  /**
   * Speaking time per day, in seconds, while a subscription to this plan is
   * current. Users without one get DAILY_LIMIT_SECONDS. The DB default only
   * exists so the column can be added to tables that already have plans.
   */
  @Column('int', { default: 3600 })
  dailyLimitSeconds: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
