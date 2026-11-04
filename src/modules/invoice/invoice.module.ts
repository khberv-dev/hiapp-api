import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RhmtModule } from '../rhmt/rhmt.module.js';
import { Invoice } from './entities/invoice.entity.js';
import { InvoiceService } from './invoice.service.js';
import { PaymentController } from './payment.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Invoice]), RhmtModule],
  controllers: [PaymentController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
