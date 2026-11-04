import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from '../../modules/auth/jwt-payload.js';

export interface AuthenticatedRequest extends Request {
  /** Set by the guards; undefined for anonymous requests under `OptionalJwtAuthGuard`. */
  user?: JwtPayload;
}

/**
 * Verifies `Authorization: Bearer <token>` and stores the payload on
 * `request.user`. Returns false when the header is absent; throws 401 when
 * it is present but malformed or invalid.
 */
async function authenticate(
  jwtService: JwtService,
  request: AuthenticatedRequest,
): Promise<boolean> {
  const header = request.headers.authorization;
  if (header === undefined) return false;

  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) {
    throw new UnauthorizedException();
  }

  try {
    request.user = await jwtService.verifyAsync<JwtPayload>(token);
  } catch {
    throw new UnauthorizedException();
  }
  return true;
}

/** Requires a valid `Authorization: Bearer <token>` header. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!(await authenticate(this.jwtService, request))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

/**
 * Lets requests without an `Authorization` header through as anonymous.
 * A header that is present but invalid is still rejected with 401.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await authenticate(this.jwtService, request);
    return true;
  }
}
