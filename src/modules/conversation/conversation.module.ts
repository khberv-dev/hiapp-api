import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module.js';
import { UserModule } from '../user/user.module.js';
import { ConversationGateway } from './conversation.gateway.js';
import { ConversationService } from './conversation.service.js';
import { Conversation } from './entities/conversation.entity.js';
import { Turn } from './entities/turn.entity.js';

@Module({
  imports: [
    AiModule,
    UserModule,
    TypeOrmModule.forFeature([Conversation, Turn]),
  ],
  providers: [ConversationGateway, ConversationService],
})
export class ConversationModule {}
