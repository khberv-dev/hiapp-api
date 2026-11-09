import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '../user/entities/user.entity.js';
import { hashPassword, verifyPassword } from '../user/password.js';
import { toUserResponse, type UserResponse } from '../user/user-response.js';
import { normalizeEmail, UserService } from '../user/user.service.js';
import { GoogleTokenVerifier } from './google-token.verifier.js';
import type { JwtPayload } from './jwt-payload.js';
import { LoginRateLimiter } from './login-rate-limiter.js';

export interface AuthResponse {
  accessToken: string;
  user: UserResponse;
}

/** 429 from `POST /auth/login`; the controller adds the `Retry-After` header. */
export class LoginRateLimitedException extends HttpException {
  constructor(readonly retryAfterSec: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many sign-in attempts, try again later',
        retryAfterSec,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class AuthService {
  /** Checked when the email is unknown, so timing doesn't reveal accounts. */
  private readonly dummyHash = hashPassword('not-a-real-password');

  constructor(
    private readonly googleTokenVerifier: GoogleTokenVerifier,
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly loginRateLimiter: LoginRateLimiter,
  ) {}

  async signInWithGoogle(idToken: string): Promise<AuthResponse> {
    const profile = await this.googleTokenVerifier.verify(idToken);
    const user = await this.userService.upsertFromGoogle(profile);
    return this.issue(user);
  }

  /**
   * Email + password sign-in for an existing user who has set a password.
   * Every failure is the same 401, whether the email is unknown, has no
   * password, or the password is wrong.
   */
  async signInWithPassword(
    email: string,
    password: string,
    ip: string,
  ): Promise<AuthResponse> {
    const key = normalizeEmail(email);
    const retryAfterSec = this.loginRateLimiter.consume(ip, key);
    if (retryAfterSec > 0) throw new LoginRateLimitedException(retryAfterSec);

    const user = await this.userService.findByEmailWithPassword(key);
    let ok = false;
    if (user?.password) {
      ok = await verifyPassword(password, user.password);
    } else {
      await verifyPassword(password, await this.dummyHash);
    }
    if (!user || !ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.loginRateLimiter.succeeded(key);
    return this.issue(user);
  }

  private async issue(user: User): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id };
    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: toUserResponse(user),
    };
  }
}
