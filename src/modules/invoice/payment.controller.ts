import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  InvoiceService,
  type PaymentCallback,
  type PaymentCallbackResult,
} from './invoice.service.js';

@Controller('payment')
export class PaymentController {
  constructor(private readonly invoiceService: InvoiceService) {}

  /**
   * Multicard success callback (RHMT_CALLBACK_URL should point here).
   * Always 200; `success: false` in the body tells Multicard to refund.
   * The body is an interface, so the global ValidationPipe leaves it alone
   * and the service validates it.
   */
  @Post('handle')
  @HttpCode(HttpStatus.OK)
  handle(@Body() payload: PaymentCallback): Promise<PaymentCallbackResult> {
    return this.invoiceService.handlePaymentCallback(payload);
  }
}
