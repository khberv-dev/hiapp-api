import { IsUUID } from 'class-validator';

export class RequestSubscriptionDto {
  @IsUUID()
  planId: string;
}
