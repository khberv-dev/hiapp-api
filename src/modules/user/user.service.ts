import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { User } from './entities/user.entity.js';
import { hashPassword } from './password.js';
import { type MeResponse, toUserResponse } from './user-response.js';

/** Unique index on `users.email`, which is stored lowercased. */
export const EMAIL_UNIQUE_INDEX = 'UQ_users_email';

/** Emails are stored and looked up trimmed and lowercased. */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

const isEmailConflict = (err: unknown): boolean =>
  err instanceof QueryFailedError &&
  (err.driverError as { code?: string; constraint?: string } | undefined)
    ?.code === '23505' &&
  (err.driverError as { constraint?: string }).constraint ===
    EMAIL_UNIQUE_INDEX;

export interface GoogleProfile {
  googleId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(User) private readonly userRepository: Repository<User>,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.userRepository.findOneBy({ id });
  }

  /** The current user's profile. 404 if the user no longer exists. */
  async getMe(id: string): Promise<MeResponse> {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.id = :id', { id })
      .getOne();
    if (!user) throw new NotFoundException('User not found');
    return { ...toUserResponse(user), hasPassword: user.password !== null };
  }

  /** For password sign-in: the user with this email, password hash included. */
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email: normalizeEmail(email) })
      .getOne();
  }

  /**
   * Creates the user for this Google account, or refreshes the profile of the
   * existing one. A single INSERT ... ON CONFLICT, so concurrent first
   * sign-ins can't create duplicates.
   *
   * Emails are unique. If another user already has this email (e.g. a second
   * Google account now claims it), this account is saved without one rather
   * than failing the sign-in.
   */
  async upsertFromGoogle(profile: GoogleProfile): Promise<User> {
    const email = profile.email ? normalizeEmail(profile.email) : null;
    try {
      await this.upsertGoogleRow({ ...profile, email });
    } catch (err) {
      if (!email || !isEmailConflict(err)) throw err;
      this.logger.warn(
        'Google sign-in: email already belongs to another user; saving without it',
      );
      await this.upsertGoogleRow({ ...profile, email: null });
    }
    return this.userRepository.findOneByOrFail({ googleId: profile.googleId });
  }

  private async upsertGoogleRow(profile: GoogleProfile): Promise<void> {
    await this.userRepository.upsert(
      { ...profile, updatedAt: new Date() },
      { conflictPaths: ['googleId'], skipUpdateIfNoValuesChanged: false },
    );
  }

  /** Sets or replaces the password (stored hashed). 404 if the user is gone. */
  async updatePassword(id: string, password: string): Promise<void> {
    const result = await this.userRepository.update(id, {
      password: await hashPassword(password),
    });
    if (!result.affected) throw new NotFoundException('User not found');
  }
}
