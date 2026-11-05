import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUserId } from '../../common/decorators/current-user-id.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { UpdatePasswordDto } from './dto/update-password.dto.js';
import { UserService } from './user.service.js';

/** The current user. Requires `Authorization: Bearer <accessToken>`. */
@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  /** Sets or replaces the password. The old password isn't required. */
  @Put('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updatePassword(
    @CurrentUserId() userId: string,
    @Body() dto: UpdatePasswordDto,
  ): Promise<void> {
    await this.userService.updatePassword(userId, dto.password);
  }
}
