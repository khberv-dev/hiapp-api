import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { InvoiceService } from '../invoice/invoice.service.js';
import { PlanService } from '../plan/plan.service.js';
import { Subscription } from './entities/subscription.entity.js';

export interface SubscriptionRequestResult {
  subscriptionId: string;
  invoiceId: string;
  /** In tiyin. */
  amount: number;
  /** Multicard payment page; open it in the app to pay. */
  checkoutUrl: string;
}

@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    private readonly planService: PlanService,
    private readonly invoiceService: InvoiceService,
  ) {}

  /**
   * Paid subscriptions that haven't ended (including ones queued to start
   * after the current one), in order, each with its plan.
   */
  findActiveByUser(userId: string): Promise<Subscription[]> {
    return this.subscriptionRepository.find({
      where: { userId, isActive: true, endDate: MoreThan(new Date()) },
      relations: { plan: true },
      order: { startDate: 'ASC' },
    });
  }

  /**
   * The paid subscription covering this moment (`startDate <= now < endDate`),
   * with its plan, or null. Stacked renewals don't overlap, so there's at most one.
   */
  findCurrentByUser(userId: string): Promise<Subscription | null> {
    const now = new Date();
    return this.subscriptionRepository.findOne({
      where: {
        userId,
        isActive: true,
        startDate: LessThanOrEqual(now),
        endDate: MoreThan(now),
      },
      relations: { plan: true },
      order: { endDate: 'DESC' },
    });
  }

  /**
   * Creates an inactive subscription and a Multicard invoice for it. The
   * subscription is activated by the payment callback.
   */
  async request(
    userId: string,
    planId: string,
  ): Promise<SubscriptionRequestResult> {
    const plan = await this.planService.findById(planId);

    const subscription = await this.subscriptionRepository.save(
      this.subscriptionRepository.create({ userId, planId }),
    );
    const invoice = await this.invoiceService.createForSubscription(
      subscription,
      plan,
    );

    return {
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      amount: invoice.amount,
      checkoutUrl: invoice.checkoutUrl!,
    };
  }
}
