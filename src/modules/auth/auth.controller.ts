import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, LoginRateLimitedException } from './auth.service.js';
import { GoogleAuthDto } from './dto/google-auth.dto.js';
import { LoginDto } from './dto/login.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Signs in (or up) with a Google ID token. */
  @Post('google')
  @HttpCode(HttpStatus.OK)
  google(@Body() dto: GoogleAuthDto) {
    return this.authService.signInWithGoogle(dto.idToken);
  }

  /**
   * Signs in with email + password (set via `PUT /user/password`).
   * 401 on any bad credentials, 429 + `Retry-After` when rate-limited.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      return await this.authService.signInWithPassword(
        dto.email,
        dto.password,
        ip,
      );
    } catch (err) {
      if (err instanceof LoginRateLimitedException) {
        res.setHeader('Retry-After', String(err.retryAfterSec));
      }
      throw err;
    }
  }
}
