import { Module } from '@nestjs/common';
import { RhmtService } from './rhmt.service.js';

@Module({
  providers: [RhmtService],
  exports: [RhmtService],
})
export class RhmtModule {}
