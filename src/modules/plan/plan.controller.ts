import { Controller, Get } from '@nestjs/common';
import { PlanService } from './plan.service.js';

/** Public: no authentication required. */
@Controller('plans')
export class PlanController {
  constructor(private readonly planService: PlanService) {}

  @Get()
  findAll() {
    return this.planService.findAll();
  }
}
