import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numberTransformer } from '../../../shared/entities/transformers.js';
import { Subscription } from '../../subscription/entities/subscription.entity.js';

export enum InvoiceStatus {
  /** Created; waiting for the payment callback. */
  Pending = 'pending',
  Paid = 'paid',
  /** Creating the invoice at the payment provider failed. */
  Failed = 'failed',
}

/**
 * A payment for a subscription. Its `id` is sent to Multicard as
 * `invoice_id` and comes back in the callback.
 */
@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  subscriptionId: string;

  @ManyToOne(() => Subscription, { onDelete: 'CASCADE' })
  subscription: Subscription;

  /** In tiyin, as sent to Multicard. */
  @Column('bigint', { transformer: numberTransformer })
  amount: number;

  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.Pending })
  status: InvoiceStatus;

  /** Multicard transaction uuid. */
  @Column({ type: 'varchar', nullable: true })
  rhmtUuid: string | null;

  @Column({ type: 'varchar', nullable: true })
  checkoutUrl: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
