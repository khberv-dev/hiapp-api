import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Base class for every entity: adds `created_at` and `updated_at`, both
 * maintained by TypeORM.
 */
export abstract class TimestampedEntity {
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
