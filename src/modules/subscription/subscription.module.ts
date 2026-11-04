import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvoiceModule } from '../invoice/invoice.module.js';
import { PlanModule } from '../plan/plan.module.js';
import { Subscription } from './entities/subscription.entity.js';
import { SubscriptionController } from './subscription.controller.js';
import { SubscriptionService } from './subscription.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription]),
    PlanModule,
    InvoiceModule,
  ],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
