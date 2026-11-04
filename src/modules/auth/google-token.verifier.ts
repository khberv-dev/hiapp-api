import {
  BadGatewayException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GoogleProfile } from '../user/user.service.js';

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const REQUEST_TIMEOUT_MS = 10_000;
const VALID_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
]);

/** Fields of Google's tokeninfo response we rely on. Values are strings. */
interface TokenInfo {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: string;
  email?: string;
  email_verified?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
}

/**
 * Validates a Google ID token with Google's tokeninfo endpoint and returns the
 * profile. Google checks the signature and expiry; we also check the issuer
 * and that the token was issued to one of *our* OAuth clients (`aud`), since
 * any app can obtain a valid Google ID token.
 */
@Injectable()
export class GoogleTokenVerifier {
  private readonly logger = new Logger(GoogleTokenVerifier.name);
  private readonly clientIds: Set<string>;

  constructor(config: ConfigService) {
    this.clientIds = new Set(
      config
        .getOrThrow<string>('GOOGLE_CLIENT_IDS')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }

  async verify(idToken: string): Promise<GoogleProfile> {
    const info = await this.fetchTokenInfo(idToken);

    if (
      !info.sub ||
      !VALID_ISSUERS.has(info.iss ?? '') ||
      !this.clientIds.has(info.aud ?? '') ||
      Number(info.exp) * 1000 <= Date.now()
    ) {
      throw new UnauthorizedException('Invalid Google ID token');
    }

    const email =
      info.email && info.email_verified === 'true'
        ? info.email.trim().toLowerCase()
        : null;
    const firstName =
      info.given_name?.trim() ||
      info.name?.trim() ||
      email?.split('@')[0] ||
      'User';

    return {
      googleId: info.sub,
      firstName,
      lastName: info.family_name?.trim() || null,
      email,
    };
  }

  private async fetchTokenInfo(idToken: string): Promise<TokenInfo> {
    const url = new URL(TOKENINFO_URL);
    url.searchParams.set('id_token', idToken);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `tokeninfo request failed: ${(error as Error).message}`,
      );
      throw new BadGatewayException('Google is unavailable');
    }

    // Google answers 400 for invalid, expired or malformed tokens.
    if (response.status >= 400 && response.status < 500) {
      throw new UnauthorizedException('Invalid Google ID token');
    }
    if (!response.ok) {
      this.logger.error(`tokeninfo responded ${response.status}`);
      throw new BadGatewayException('Google is unavailable');
    }

    const body = (await response.json().catch(() => null)) as unknown;
    if (typeof body !== 'object' || body === null) {
      throw new BadGatewayException('Google returned an invalid response');
    }
    return body as TokenInfo;
  }
}
