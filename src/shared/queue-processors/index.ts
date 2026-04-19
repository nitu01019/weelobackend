/**
 * Queue Processors - Barrel Export
 *
 * Each processor is extracted from QueueService.registerDefaultProcessors()
 * into its own file for maintainability. Each processor is independent
 * with zero shared state.
 */

export { registerBroadcastProcessor } from './broadcast.processor';
export type { BroadcastProcessorDeps } from './broadcast.processor';

export { registerPushNotificationProcessor } from './push-notification.processor';

export { registerFcmBatchProcessor } from './fcm-batch.processor';

export { registerTrackingEventsProcessor } from './tracking-events.processor';
export type { TrackingStreamSink } from './tracking-events.processor';

export { registerVehicleReleaseProcessor } from './vehicle-release.processor';

export { registerAssignmentReconciliationProcessor } from './assignment-reconciliation.processor';
export type { ReconciliationProcessorDeps } from './assignment-reconciliation.processor';

export { startAssignmentTimeoutPoller } from './assignment-timeout-poller';
