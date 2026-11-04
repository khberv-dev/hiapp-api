import {
  Column,
  CreateDateColumn,
  Entity,
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

  /** Only set when the provider says it's verified. Not unique. */
  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  /** Google account id (the ID token's `sub`). Null for other sign-in methods. */
  @Column({ type: 'varchar', nullable: true, unique: true })
  googleId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
