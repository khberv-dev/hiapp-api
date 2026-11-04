import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, MoreThan, Repository } from 'typeorm';
import type { Plan } from '../plan/entities/plan.entity.js';
import { RhmtService } from '../rhmt/rhmt.service.js';
import { Subscription } from '../subscription/entities/subscription.entity.js';
import { User } from '../user/entities/user.entity.js';
import { Invoice, InvoiceStatus } from './entities/invoice.entity.js';

const DAY_MS = 86_400_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body of Multicard's success callback (only the fields we use). */
export interface PaymentCallback {
  store_id?: unknown;
  invoice_id?: unknown;
  amount?: unknown;
  uuid?: unknown;
  sign?: unknown;
}

/** Reply format Multicard expects. `success: false` cancels and refunds. */
export interface PaymentCallbackResult {
  success: boolean;
  message?: string;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rhmt: RhmtService,
  ) {}

  /**
   * Creates our invoice row, then the Multicard invoice for it.
   * Amount in tiyin = plan price (UZS) × 100.
   */
  async createForSubscription(
    subscription: Subscription,
    plan: Plan,
  ): Promise<Invoice> {
    const invoice = await this.invoiceRepository.save(
      this.invoiceRepository.create({
        subscriptionId: subscription.id,
        amount: Math.round(plan.price * 100),
      }),
    );

    try {
      const rhmtInvoice = await this.rhmt.createInvoice({
        amount: invoice.amount,
        invoiceId: invoice.id,
      });
      invoice.rhmtUuid = rhmtInvoice.uuid;
      invoice.checkoutUrl = rhmtInvoice.checkoutUrl;
    } catch (error) {
      invoice.status = InvoiceStatus.Failed;
      await this.invoiceRepository.save(invoice);
      throw error;
    }

    return this.invoiceRepository.save(invoice);
  }

  /**
   * Handles Multicard's success callback. Idempotent: a repeated callback for
   * an already-paid invoice with the same uuid succeeds again without changes.
   * Unexpected errors propagate as 500, which makes Multicard retry.
   */
  async handlePaymentCallback(
    payload: PaymentCallback,
  ): Promise<PaymentCallbackResult> {
    const { store_id, invoice_id, amount, uuid, sign } = payload;

    if (
      (typeof store_id !== 'number' && typeof store_id !== 'string') ||
      typeof invoice_id !== 'string' ||
      typeof amount !== 'number' ||
      typeof uuid !== 'string' ||
      typeof sign !== 'string'
    ) {
      return this.reject('Invalid payload', payload);
    }
    if (!this.rhmt.verifyCallbackSign(store_id, invoice_id, amount, sign)) {
      return this.reject('Invalid signature', payload);
    }
    if (String(store_id) !== this.rhmt.configuredStoreId) {
      return this.reject('Unknown store', payload);
    }
    if (!UUID_RE.test(invoice_id)) {
      return this.reject('Invoice not found', payload);
    }

    return this.dataSource.transaction(async (manager) => {
      // Row lock: concurrent duplicate callbacks are processed one at a time.
      const invoice = await manager.findOne(Invoice, {
        where: { id: invoice_id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!invoice) return this.reject('Invoice not found', payload);
      if (invoice.amount !== amount) {
        return this.reject('Amount mismatch', payload);
      }
      if (invoice.status === InvoiceStatus.Paid) {
        return invoice.rhmtUuid === uuid
          ? { success: true }
          : this.reject('Invoice already paid', payload);
      }

      const now = new Date();
      invoice.status = InvoiceStatus.Paid;
      invoice.rhmtUuid = uuid;
      invoice.paidAt = now;
      await manager.save(invoice);
      await this.activateSubscription(manager, invoice.subscriptionId, now);

      this.logger.log(
        `Invoice ${invoice.id} paid (${uuid}); subscription ${invoice.subscriptionId} activated`,
      );
      return { success: true };
    });
  }

  /**
   * Sets the subscription's dates. If the user still has paid time left, the
   * new period starts when that ends, so renewing early loses nothing.
   */
  private async activateSubscription(
    manager: EntityManager,
    subscriptionId: string,
    now: Date,
  ): Promise<void> {
    const subscription = await manager.findOneOrFail(Subscription, {
      where: { id: subscriptionId },
      relations: { plan: true },
    });

    // Serialize activations per user, so two payments landing at once
    // can't both start at the same moment.
    await manager.findOne(User, {
      where: { id: subscription.userId },
      lock: { mode: 'pessimistic_write' },
    });
    const latest = await manager.findOne(Subscription, {
      where: {
        userId: subscription.userId,
        isActive: true,
        endDate: MoreThan(now),
      },
      order: { endDate: 'DESC' },
    });

    const startDate = latest?.endDate ?? now;
    await manager.update(
      Subscription,
      { id: subscription.id },
      {
        isActive: true,
        startDate,
        endDate: new Date(
          startDate.getTime() + subscription.plan.durationDays * DAY_MS,
        ),
      },
    );
  }

  private reject(
    message: string,
    payload: PaymentCallback,
  ): PaymentCallbackResult {
    this.logger.warn(
      `Payment callback rejected: ${message} (invoice_id=${String(payload.invoice_id)}, uuid=${String(payload.uuid)})`,
    );
    return { success: false, message };
  }
}
