import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { User } from '../user/entities/user.entity.js';
import { hashPassword } from '../user/password.js';
import type { UserService } from '../user/user.service.js';
import { AuthService, LoginRateLimitedException } from './auth.service.js';
import type { GoogleTokenVerifier } from './google-token.verifier.js';
import { LoginRateLimiter } from './login-rate-limiter.js';

describe('AuthService.signInWithPassword', () => {
  let user: User;
  let findByEmailWithPassword: ReturnType<typeof vi.fn>;
  let limiter: LoginRateLimiter;
  let service: AuthService;

  beforeEach(async () => {
    user = {
      id: 'u1',
      firstName: 'Ann',
      lastName: null,
      email: 'ann@example.com',
      googleId: 'g1',
      password: await hashPassword('correct horse'),
    } as User;
    findByEmailWithPassword = vi.fn(async (email: string) =>
      email === 'ann@example.com' ? user : null,
    );
    limiter = new LoginRateLimiter({
      maxPerEmail: 3,
      maxPerIp: 100,
      windowMs: 60_000,
    });
    service = new AuthService(
      {} as GoogleTokenVerifier,
      { findByEmailWithPassword } as unknown as UserService,
      { signAsync: vi.fn(async () => 'jwt') } as unknown as JwtService,
      limiter,
    );
  });
  afterEach(() => limiter.onModuleDestroy());

  it('signs in with the right password, normalizing the email', async () => {
    const res = await service.signInWithPassword(
      '  Ann@Example.COM ',
      'correct horse',
      'ip',
    );
    expect(res).toEqual({
      accessToken: 'jwt',
      user: {
        id: 'u1',
        firstName: 'Ann',
        lastName: null,
        email: 'ann@example.com',
      },
    });
    expect(findByEmailWithPassword).toHaveBeenCalledWith('ann@example.com');
    expect(JSON.stringify(res)).not.toContain('scrypt');
  });

  it.each([
    ['wrong password', 'ann@example.com', 'nope'],
    ['unknown email', 'who@example.com', 'correct horse'],
  ])('rejects %s with the same 401', async (_, email, password) => {
    const err = await service
      .signInWithPassword(email, password, 'ip')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as Error).message).toBe('Invalid email or password');
  });

  it('rejects a user without a password', async () => {
    user.password = null;
    await expect(
      service.signInWithPassword('ann@example.com', 'anything', 'ip'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rate-limits per email, even with the right password, and resets on success', async () => {
    for (let i = 0; i < 2; i++) {
      await expect(
        service.signInWithPassword('ann@example.com', 'nope', 'ip'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await service.signInWithPassword('ann@example.com', 'correct horse', 'ip');

    for (let i = 0; i < 3; i++) {
      await expect(
        service.signInWithPassword('ANN@example.com', 'nope', 'ip'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const err = await service
      .signInWithPassword('ann@example.com', 'correct horse', 'ip')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginRateLimitedException);
    expect((err as LoginRateLimitedException).getStatus()).toBe(429);
    expect((err as LoginRateLimitedException).retryAfterSec).toBe(60);
  });
});
