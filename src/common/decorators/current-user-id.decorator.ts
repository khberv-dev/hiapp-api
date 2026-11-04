import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard.js';

/**
 * Id of the authenticated user. Always set under `JwtAuthGuard`; `null` for
 * anonymous requests under `OptionalJwtAuthGuard`.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user?.sub ?? null,
);
