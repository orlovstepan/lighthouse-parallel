import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fork, ChildProcess } from 'child_process';
import { join } from 'path';
import { LighthouseMetricsService } from '../metrics/lighthouse-metrics.service';
import { WebhookService } from './webhook.service';
import type { LighthouseResult, ChildMessage } from './workers/lighthouse-runner';

export interface LighthouseJobData {
  url: string;
  categories?: string[];
  locale?: string;
  jobId: string;
  batchId?: string;
  webhookUrl?: string;
  webhookToken?: string;
}

export interface LighthouseJobResult extends LighthouseResult {
  scores?: {
    performance: number;
    accessibility: number;
    seo: number;
    'best-practices': number;
  };
}

@Processor('lighthouse-audits', {
  lockDuration: 150000, // 150 seconds (> 120s Lighthouse timeout)
})
export class LighthouseProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(LighthouseProcessor.name);
  private readonly concurrency: number;

  constructor(
    private configService: ConfigService,
    private metricsService: LighthouseMetricsService,
    private webhookService: WebhookService,
  ) {
    super();
    const concurrencyValue = parseInt(
      this.configService.get<string>('WORKER_CONCURRENCY', '10'),
      10,
    );
    this.concurrency =
      Number.isFinite(concurrencyValue) && concurrencyValue > 0 ? concurrencyValue : 10;
    this.logger.log(`Processor initialized with concurrency: ${this.concurrency}`);
  }

  onModuleInit() {
    // Update worker concurrency dynamically after initialization
    if (this.worker && Number.isFinite(this.concurrency) && this.concurrency > 0) {
      this.worker.concurrency = this.concurrency;
      this.logger.log(`Worker concurrency set to: ${this.concurrency}`);
    } else {
      this.logger.warn(`Invalid concurrency value: ${this.concurrency}, using default`);
    }
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  getMaxConcurrency(): number {
    return this.concurrency;
  }

  async process(job: Job<LighthouseJobData>): Promise<LighthouseJobResult> {
    const { url, categories, locale } = job.data;
    const startTime = Date.now();

    this.metricsService.recordJobStart();
    this.logger.log(`Starting audit for ${url} (Job: ${job.id})`);

    try {
      const result = await new Promise<LighthouseResult>((resolve, reject) => {
        const workerPath = join(__dirname, 'workers', 'lighthouse-runner.js');
        const child: ChildProcess = fork(workerPath, [], {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env },
        });

        let resultReceived = false;
        const timeout = setTimeout(() => {
          if (!resultReceived) {
            resultReceived = true;
            child.kill('SIGKILL');
            reject(new Error(`Lighthouse audit timed out for ${url}`));
          }
        }, 120000);

        child.on('message', (msg: ChildMessage) => {
          if (msg.type === 'AUDIT_RESULT' && !resultReceived) {
            resultReceived = true;
            clearTimeout(timeout);
            child.kill('SIGKILL');
            if (msg.result.success) {
              resolve(msg.result);
            } else {
              reject(new Error(msg.result.error));
            }
          }
        });

        child.on('error', (error) => {
          if (!resultReceived) {
            resultReceived = true;
            clearTimeout(timeout);
            reject(error);
          }
        });

        child.on('exit', (code) => {
          if (!resultReceived) {
            resultReceived = true;
            clearTimeout(timeout);
            reject(new Error(`Child process exited with code ${code}`));
          }
        });

        child.send({ type: 'RUN_AUDIT', url, options: { categories, locale } });
      });

      const durationSeconds = (Date.now() - startTime) / 1000;
      this.metricsService.recordJobCompleted(durationSeconds, url);
      this.logger.log(`Completed audit for ${url} in ${result.duration}ms`);

      // Return result with pre-computed scores (webhook will be sent in onCompleted)
      return {
        ...result,
        scores: this.extractScores(result),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'unknown';
      this.metricsService.recordJobFailed(errorMessage);
      this.logger.error(`Audit failed for ${url}: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Extract scores and convert from 0-1 to 0-100 scale
   */
  private extractScores(result: LighthouseResult) {
    if (result.lhr?.categories) {
      return {
        performance: Math.round((result.lhr.categories.performance?.score || 0) * 100),
        accessibility: Math.round((result.lhr.categories.accessibility?.score || 0) * 100),
        seo: Math.round((result.lhr.categories.seo?.score || 0) * 100),
        'best-practices': Math.round((result.lhr.categories['best-practices']?.score || 0) * 100),
      };
    }
    return {
      performance: 0,
      accessibility: 0,
      seo: 0,
      'best-practices': 0,
    };
  }

  @OnWorkerEvent('active')
  onActive(job: Job<LighthouseJobData>) {
    this.logger.log(`Job ${job.id} active: ${job.data.url}`);
  }

  /**
   * Queue webhook after job completes - receiver fetches full LHR from Redis
   */
  @OnWorkerEvent('completed')
  async onCompleted(job: Job<LighthouseJobData, LighthouseJobResult>) {
    const { url, batchId, webhookUrl, webhookToken } = job.data;

    this.logger.log(`Job ${job.id} completed: ${url}`);

    if (webhookUrl) {
      await this.webhookService.queueWebhook({
        jobId: job.id as string,
        batchId,
        state: 'completed',
        webhookUrl,
        webhookToken,
      });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<LighthouseJobData>, error: Error) {
    const { url, batchId, webhookUrl, webhookToken } = job.data;

    this.logger.error(`Job ${job.id} failed: ${url} - ${error.message}`);

    if (webhookUrl) {
      await this.webhookService.queueWebhook({
        jobId: job.id as string,
        batchId,
        state: 'failed',
        error: error.message,
        webhookUrl,
        webhookToken,
      });
    }
  }
}
