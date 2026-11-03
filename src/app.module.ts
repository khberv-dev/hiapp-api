import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  buildDataSourceOptions,
  createDataSource,
} from './shared/config/database.config.js';
import { UserModule } from './modules/user/user.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConversationModule } from './modules/conversation/conversation.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildDataSourceOptions(config),
        autoLoadEntities: true,
      }),
      dataSourceFactory: (options) => createDataSource(options!),
    }),
    UserModule,
    AuthModule,
    ConversationModule,
  ],
})
export class AppModule {}
