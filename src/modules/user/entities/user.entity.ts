import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '../../../shared/entities/timestamped.entity.js';

@Entity('users')
export class User extends TimestampedEntity {
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
}
