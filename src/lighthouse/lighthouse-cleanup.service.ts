import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LighthouseService } from './lighthouse.service';
import { WebhookService } from './webhook.service';
import { CleanupAllResult } from './interfaces/queue-stats.interface';

@Injectable()
export class LighthouseCleanupService {
  private readonly logger = new Logger(LighthouseCleanupService.name);

  constructor(
    private readonly lighthouseService: LighthouseService,
    private readonly webhookService: WebhookService,
  ) {}

  /**
   * Clean up jobs every hour
   * Only removes Lighthouse jobs whose webhooks have been delivered (IncluScan responded 200)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOldJobs() {
    this.logger.log('Starting automatic cleanup (hourly)...');

    try {
      await this.cleanEverything();
      this.logger.log('Automatic cleanup completed successfully');
    } catch (error) {
      this.logger.error('Error during automatic cleanup:', error);
    }
  }

  /**
   * Clean jobs intelligently - only remove Lighthouse jobs whose webhooks are resolved
   * A webhook is "resolved" when IncluScan has responded 200 (after fetching LHR)
   */
  async cleanEverything(): Promise<CleanupAllResult> {
    this.logger.log('Cleanup triggered - removing jobs with delivered webhooks');

    const lighthouseQueue = this.lighthouseService.getQueue();
    const webhookQueue = this.webhookService.getQueue();

    // 1. Get all completed Lighthouse jobs
    const completedLighthouseJobs = await lighthouseQueue.getJobs(['completed']);

    // 2. Get all completed webhook jobs → build Set of resolved Lighthouse job IDs
    const completedWebhooks = await webhookQueue.getJobs(['completed']);
    const resolvedJobIds = new Set(
      completedWebhooks.map((w) => w.data?.jobId).filter(Boolean),
    );

    this.logger.log(
      `Found ${completedLighthouseJobs.length} completed Lighthouse jobs, ` +
        `${resolvedJobIds.size} with resolved webhooks`,
    );

    // 3. Remove only Lighthouse jobs whose webhook is resolved (or no webhook configured)
    let completedCleaned = 0;
    let skippedPendingWebhook = 0;

    for (const job of completedLighthouseJobs) {
      const jobId = job.id as string;

      if (!job.data?.webhookUrl) {
        // No webhook configured - safe to remove
        await job.remove();
        completedCleaned++;
      } else if (resolvedJobIds.has(jobId)) {
        // Webhook delivered successfully - safe to remove
        await job.remove();
        completedCleaned++;
      } else {
        // Webhook not yet delivered - keep the job
        skippedPendingWebhook++;
      }
    }

    // 4. Clean failed Lighthouse jobs (always safe - no LHR to recover)
    const failedCleaned = await lighthouseQueue.clean(0, 10000, 'failed');

    // 5. Clear only batches where ALL jobs have resolved webhooks
    this.lighthouseService.clearResolvedBatches(resolvedJobIds);

    // 6. Clean completed webhook jobs (they've served their purpose as "proof")
    await webhookQueue.clean(0, 10000, 'completed');

    const stats = await this.lighthouseService.getQueueStats();

    this.logger.log(
      `Cleanup done. Removed ${completedCleaned + failedCleaned.length} jobs ` +
        `(${completedCleaned} completed, ${failedCleaned.length} failed), ` +
        `skipped ${skippedPendingWebhook} pending webhook delivery`,
    );

    return {
      cleaned: completedCleaned + failedCleaned.length,
      completedCleaned,
      failedCleaned: failedCleaned.length,
      stats,
    };
  }
}
