import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const queueConfig = BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    connection: {
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get<string>('REDIS_PASSWORD') || undefined,
      username: configService.get<string>('REDIS_USERNAME') || undefined,
      db: configService.get<number>('REDIS_DB', 0),
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
    streams: {
      events: { maxLen: 500 },
    },
  }),
});

export const LIGHTHOUSE_QUEUE = 'lighthouse-audits';
export const WEBHOOK_QUEUE = 'webhook-delivery';
