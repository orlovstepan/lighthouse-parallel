import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LighthouseAuditController } from './controllers/lighthouse-audit.controller';
import { LighthouseAdminController } from './controllers/lighthouse-admin.controller';
import { LighthouseService } from './lighthouse.service';
import { LighthouseProcessor } from './lighthouse.processor';
import { LighthouseCleanupService } from './lighthouse-cleanup.service';
import { WebhookProcessor } from './webhook.processor';
import { WebhookService } from './webhook.service';
import { LIGHTHOUSE_QUEUE, WEBHOOK_QUEUE } from '../config/queue.config';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: LIGHTHOUSE_QUEUE,
    }),
    BullModule.registerQueue({
      name: WEBHOOK_QUEUE,
    }),
    MetricsModule,
  ],
  controllers: [LighthouseAuditController, LighthouseAdminController],
  providers: [
    LighthouseService,
    LighthouseProcessor,
    LighthouseCleanupService,
    WebhookProcessor,
    WebhookService,
  ],
  exports: [LighthouseService, WebhookService],
})
export class LighthouseModule {}
