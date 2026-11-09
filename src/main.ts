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
  const config = app.get(ConfigService);
  // Behind a reverse proxy, req.ip (used by the login rate limit) is the
  // proxy's address unless Express is told to trust X-Forwarded-For.
  const trustProxy = parseTrustProxy(config.get<string>('TRUST_PROXY'));
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
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
  const port = config.getOrThrow('PORT');

  await app.listen(port);

  logger.log(`Listening on :${port}`);
}
/** `true`/`false`, a hop count, or an Express trust string (e.g. `loopback`). */
function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

await bootstrap();
