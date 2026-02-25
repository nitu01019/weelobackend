import { logger } from './logger.service';
import type { TrackingEventPayload } from './queue.service';
import { metrics } from '../monitoring/metrics.service';

export interface TrackingStreamSink {
  publishTrackingEvents(events: TrackingEventPayload[]): Promise<void>;
  flush(): Promise<void>;
}

export class NoopTrackingSink implements TrackingStreamSink {
  async publishTrackingEvents(_events: TrackingEventPayload[]): Promise<void> {
    return;
  }

  async flush(): Promise<void> {
    return;
  }
}

export class KinesisTrackingSink implements TrackingStreamSink {
  private client: any | null = null;
  private readonly streamName: string;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly maxRetries: number;
  private readonly buffer: TrackingEventPayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(streamName: string) {
    this.streamName = streamName;
    this.batchSize = Math.max(1, Math.min(500, parseInt(process.env.TRACKING_STREAM_BATCH_SIZE || '100', 10) || 100));
    this.flushMs = Math.max(10, parseInt(process.env.TRACKING_STREAM_FLUSH_MS || '250', 10) || 250);
    this.maxRetries = Math.max(0, parseInt(process.env.TRACKING_STREAM_MAX_RETRIES || '3', 10) || 3);
  }

  private getClient(): any | null {
    if (this.client) return this.client;
    try {
      // Runtime-only load keeps this path optional for environments without SDK installed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require('@aws-sdk/client-kinesis');
      const region = process.env.AWS_REGION || 'ap-south-1';
      this.client = new sdk.KinesisClient({ region });
      return this.client;
    } catch (error: any) {
      logger.warn('[TrackingStream] Kinesis SDK unavailable, falling back to no-op sink', {
        message: error?.message || 'unknown'
      });
      return null;
    }
  }

  async publishTrackingEvents(events: TrackingEventPayload[]): Promise<void> {
    if (events.length === 0) return;

    this.buffer.push(...events);
    metrics.setGauge('tracking_stream_buffer_depth', this.buffer.length);

    if (this.buffer.length >= this.batchSize) {
      await this.flushBufferedEvents();
      return;
    }

    this.ensureFlushTimer();
  }

  async flush(): Promise<void> {
    await this.flushBufferedEvents();
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushBufferedEvents().catch((error: any) => {
        logger.warn('[TrackingStream] Timer-based flush failed', {
          message: error?.message || 'unknown'
        });
      });
    }, this.flushMs);
    this.flushTimer.unref?.();
  }

  private async flushBufferedEvents(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }
    this.flushInFlight = this.flushBufferedEventsInternal().finally(() => {
      this.flushInFlight = null;
    });
    await this.flushInFlight;
  }

  private async flushBufferedEventsInternal(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) return;

    const client = this.getClient();
    if (!client) {
      const dropped = this.buffer.length;
      this.buffer.length = 0;
      metrics.setGauge('tracking_stream_buffer_depth', 0);
      if (dropped > 0) {
        metrics.incrementCounter('tracking_stream_publish_fail_total', { reason: 'sink_unavailable' }, dropped);
        metrics.incrementCounter('tracking_stream_dropped_total', { reason: 'sink_unavailable' }, dropped);
      }
      return;
    }

    while (this.buffer.length > 0) {
      const chunk = this.buffer.splice(0, this.batchSize);
      metrics.observeHistogram('tracking_stream_batch_size', chunk.length);
      await this.sendChunkWithRetry(client, chunk);
      metrics.setGauge('tracking_stream_buffer_depth', this.buffer.length);
    }
  }

  private async sendChunkWithRetry(client: any, chunk: TrackingEventPayload[]): Promise<void> {
    let pending = chunk;
    let attempt = 0;

    while (pending.length > 0) {
      attempt += 1;
      const failed = await this.putRecords(client, pending);
      const successCount = pending.length - failed.length;

      if (successCount > 0) {
        metrics.incrementCounter('tracking_stream_publish_success_total', {}, successCount);
      }

      if (failed.length === 0) {
        return;
      }

      metrics.incrementCounter('tracking_stream_publish_fail_total', { reason: 'kinesis_failed_records' }, failed.length);

      if (attempt > this.maxRetries) {
        metrics.incrementCounter('tracking_stream_dropped_total', { reason: 'max_retries_exceeded' }, failed.length);
        logger.warn('[TrackingStream] Dropping tracking events after retries', {
          stream: this.streamName,
          failedCount: failed.length,
          maxRetries: this.maxRetries
        });
        return;
      }

      metrics.incrementCounter('tracking_stream_retry_total', { attempt: String(attempt) }, failed.length);
      await this.sleepWithJitter(attempt);
      pending = failed;
    }
  }

  private async putRecords(client: any, events: TrackingEventPayload[]): Promise<TrackingEventPayload[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require('@aws-sdk/client-kinesis');
      const command = new sdk.PutRecordsCommand({
        StreamName: this.streamName,
        Records: events.map((event) => ({
          PartitionKey: this.resolvePartitionKey(event),
          Data: Buffer.from(JSON.stringify(event))
        }))
      });

      const response = await client.send(command);
      const records = Array.isArray(response?.Records) ? response.Records : [];
      const failedEvents: TrackingEventPayload[] = [];

      for (let i = 0; i < events.length; i++) {
        const record = records[i];
        if (record?.ErrorCode) {
          failedEvents.push(events[i]);
        }
      }

      return failedEvents;
    } catch (error: any) {
      logger.warn('[TrackingStream] Failed to publish batch to Kinesis', {
        stream: this.streamName,
        batchSize: events.length,
        message: error?.message || 'unknown'
      });
      return events;
    }
  }

  private resolvePartitionKey(event: TrackingEventPayload): string {
    return event.driverId || event.tripId || event.bookingId || event.orderId || 'tracking';
  }

  private async sleepWithJitter(attempt: number): Promise<void> {
    const baseDelayMs = Math.min(2500, 100 * Math.pow(2, attempt - 1));
    const jitterMs = Math.floor(Math.random() * 100);
    const delayMs = baseDelayMs + jitterMs;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

export function createTrackingStreamSink(): TrackingStreamSink {
  const provider = (process.env.TRACKING_STREAM_PROVIDER || '').toLowerCase();
  if (provider === 'kinesis') {
    const streamName = process.env.TRACKING_KINESIS_STREAM || '';
    if (!streamName) {
      logger.warn('[TrackingStream] TRACKING_STREAM_PROVIDER=kinesis but TRACKING_KINESIS_STREAM is not set');
      return new NoopTrackingSink();
    }
    return new KinesisTrackingSink(streamName);
  }
  if (provider && provider !== 'none') {
    logger.warn('[TrackingStream] Unsupported provider configured; falling back to no-op sink', {
      provider
    });
  }
  return new NoopTrackingSink();
}
