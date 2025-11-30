import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WebhookJobData } from './webhook.processor';
import { WEBHOOK_QUEUE } from '../config/queue.config';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectQueue(WEBHOOK_QUEUE)
    private webhookQueue: Queue<WebhookJobData>,
  ) {}

  /**
   * Queue a webhook delivery job
   * Will be processed sequentially (concurrency: 1) with retry on failure
   */
  async queueWebhook(data: WebhookJobData): Promise<string> {
    const job = await this.webhookQueue.add('deliver', data, {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000, // Start at 2s, then 4s, 8s, 16s, 32s
      },
      removeOnComplete: 100, // Keep last 100 completed jobs
      removeOnFail: 50, // Keep last 50 failed jobs
    });

    this.logger.log(
      `Queued webhook for job ${data.jobId} -> ${data.webhookUrl} (webhook job: ${job.id})`,
    );

    return job.id as string;
  }

  /**
   * Get webhook queue stats
   */
  async getQueueStats() {
    const waiting = await this.webhookQueue.getWaitingCount();
    const active = await this.webhookQueue.getActiveCount();
    const completed = await this.webhookQueue.getCompletedCount();
    const failed = await this.webhookQueue.getFailedCount();

    return { waiting, active, completed, failed };
  }

  /**
   * Expose queue instance for cleanup service
   */
  getQueue(): Queue<WebhookJobData> {
    return this.webhookQueue;
  }
}
