import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { WEBHOOK_QUEUE } from '../config/queue.config';

/**
 * Minimal webhook payload - IncluScan fetches url/scores/lhr from Redis
 */
export interface WebhookJobData {
  jobId: string;
  batchId?: string;
  state: 'completed' | 'failed';
  error?: string; // Only for failed jobs
  webhookUrl: string;
  webhookToken?: string;
}

@Processor(WEBHOOK_QUEUE, {
  concurrency: 3, // Process 3 webhooks in parallel (IncluScan can handle it)
})
export class WebhookProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(WebhookProcessor.name);

  onModuleInit() {
    this.logger.log('Webhook processor initialized with concurrency: 3');
  }

  async process(job: Job<WebhookJobData>): Promise<{ success: boolean; statusCode?: number }> {
    const { jobId, batchId, state, error, webhookUrl, webhookToken } = job.data;

    this.logger.log(`Sending webhook for job ${jobId} to ${webhookUrl}`);

    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      if (webhookToken) {
        headers['Authorization'] = `Bearer ${webhookToken}`;
      }

      // Minimal payload - IncluScan fetches url/scores/lhr from Redis
      const payload = {
        jobId,
        batchId,
        status: state,
        ...(state === 'failed' && error ? { error } : {}),
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      this.logger.log(`Webhook sent successfully for job ${jobId}`);

      return { success: true, statusCode: response.status };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Webhook failed for job ${jobId}: ${errorMessage}`);
      // Throw to trigger BullMQ retry with exponential backoff
      throw err;
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job<WebhookJobData>) {
    this.logger.debug(`Webhook job ${job.id} is now active`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<WebhookJobData>) {
    this.logger.log(`Webhook job ${job.id} completed successfully`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<WebhookJobData>, error: Error) {
    this.logger.error(`Webhook job ${job.id} failed after all retries: ${error.message}`);
  }
}
