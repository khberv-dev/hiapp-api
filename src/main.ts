import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module.js';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const logger = new Logger('App');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Static pages (e.g. /privacy_policy) from <project>/public; main.js runs from dist/.
  app.useStaticAssets(join(import.meta.dirname, '..', 'public'), {
    extensions: ['html'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const port = config.getOrThrow('PORT');

  await app.listen(port);

  logger.log(`Listening on :${port}`);
}
await bootstrap();
