import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '../user/entities/user.entity.js';
import { UserService } from '../user/user.service.js';
import { GoogleTokenVerifier } from './google-token.verifier.js';
import type { JwtPayload } from './jwt-payload.js';

export interface UserResponse {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
}

export interface AuthResponse {
  accessToken: string;
  user: UserResponse;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly googleTokenVerifier: GoogleTokenVerifier,
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  async signInWithGoogle(idToken: string): Promise<AuthResponse> {
    const profile = await this.googleTokenVerifier.verify(idToken);
    const user = await this.userService.upsertFromGoogle(profile);
    const payload: JwtPayload = { sub: user.id };

    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: toUserResponse(user),
    };
  }
}

function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
  };
}
