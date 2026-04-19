/**
 * Vehicle Release Queue Processor
 *
 * Retries failed vehicle releases with exponential backoff.
 * Max 5 retries (2s, 4s, 8s, 16s, 32s).
 */

import { logger } from '../services/logger.service';
import type { QueueJob } from '../services/queue.service';

export function registerVehicleReleaseProcessor(
  queue: { process(queueName: string, processor: (job: QueueJob) => Promise<void>): void },
  queueName: string
): void {
  queue.process(queueName, async (job) => {
    const { vehicleId, context } = job.data;
    const { releaseVehicle }: typeof import('../services/vehicle-lifecycle.service') = require('../services/vehicle-lifecycle.service');
    await releaseVehicle(vehicleId, `retry:${context}`);
    logger.info(`[VEHICLE_RELEASE] Successfully released vehicle ${vehicleId} on retry attempt ${job.attempts}`);
  });
}
