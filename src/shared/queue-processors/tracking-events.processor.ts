/**
 * Tracking Events Queue Processor
 *
 * Sinks driver telemetry events to the configured tracking stream.
 * Default sink is no-op to avoid blocking hot path when no sink is configured.
 */

import type { QueueJob, TrackingEventPayload } from '../services/queue.service';

export interface TrackingStreamSink {
  publishTrackingEvents(events: TrackingEventPayload[]): Promise<void>;
}

export function registerTrackingEventsProcessor(
  queue: { process(queueName: string, processor: (job: QueueJob) => Promise<void>): void },
  trackingStreamSink: TrackingStreamSink,
  queueName: string
): void {
  queue.process(queueName, async (job) => {
    await trackingStreamSink.publishTrackingEvents([job.data as TrackingEventPayload]);
  });
}
