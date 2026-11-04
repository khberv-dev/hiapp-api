import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUserId } from '../../common/decorators/current-user-id.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RequestSubscriptionDto } from './dto/request-subscription.dto.js';
import { SubscriptionService } from './subscription.service.js';

/** The current user's subscriptions. Requires `Authorization: Bearer <accessToken>`. */
@Controller('subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get()
  findMine(@CurrentUserId() userId: string) {
    return this.subscriptionService.findActiveByUser(userId);
  }

  /** Starts a purchase: returns the Multicard checkout URL to pay. */
  @Post()
  request(
    @CurrentUserId() userId: string,
    @Body() dto: RequestSubscriptionDto,
  ) {
    return this.subscriptionService.request(userId, dto.planId);
  }
}
