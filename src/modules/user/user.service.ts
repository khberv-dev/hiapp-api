import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity.js';
import { hashPassword } from './password.js';

export interface GoogleProfile {
  googleId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
}

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User) private readonly userRepository: Repository<User>,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.userRepository.findOneBy({ id });
  }

  /**
   * Creates the user for this Google account, or refreshes the profile of the
   * existing one. A single INSERT ... ON CONFLICT, so concurrent first
   * sign-ins can't create duplicates.
   */
  async upsertFromGoogle(profile: GoogleProfile): Promise<User> {
    await this.userRepository.upsert(
      { ...profile, updatedAt: new Date() },
      { conflictPaths: ['googleId'], skipUpdateIfNoValuesChanged: false },
    );
    return this.userRepository.findOneByOrFail({ googleId: profile.googleId });
  }

  /** Sets or replaces the password (stored hashed). 404 if the user is gone. */
  async updatePassword(id: string, password: string): Promise<void> {
    const result = await this.userRepository.update(id, {
      password: await hashPassword(password),
    });
    if (!result.affected) throw new NotFoundException('User not found');
  }
}
