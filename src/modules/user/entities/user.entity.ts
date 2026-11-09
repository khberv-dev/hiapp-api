import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  firstName: string;

  @Column({ type: 'varchar', nullable: true })
  lastName: string | null;

  /**
   * Lowercased (`normalizeEmail`). Only set when the provider says it's
   * verified. Unique (several nulls are fine), so it can be a sign-in name.
   */
  @Index('UQ_users_email', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  /** Google account id (the ID token's `sub`). Null for other sign-in methods. */
  @Column({ type: 'varchar', nullable: true, unique: true })
  googleId: string | null;

  /**
   * scrypt hash (`hashPassword`), never the plain password. Null until the
   * user sets one. `select: false`: load it explicitly with
   * `addSelect('user.password')` when it's needed.
   */
  @Column({ type: 'varchar', nullable: true, select: false })
  password: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
