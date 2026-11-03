import { ConfigService } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy.js';

export function buildDataSourceOptions(
  config: ConfigService,
): DataSourceOptions {
  return {
    type: 'postgres',
    host: config.getOrThrow<string>('DB_HOST'),
    port: Number(config.getOrThrow('DB_PORT')),
    username: config.getOrThrow<string>('DB_USERNAME'),
    password: config.getOrThrow<string>('DB_PASSWORD'),
    database: config.getOrThrow<string>('DB_NAME'),
    namingStrategy: new SnakeNamingStrategy(),
    // Schema is kept in sync with entities automatically; no migrations.
    synchronize: true,
    migrations: [],
  };
}

export async function createDataSource(
  options: DataSourceOptions,
): Promise<DataSource> {
  return new DataSource(options).initialize();
}
