/**
 * =============================================================================
 * ORDER TIMEOUT MODULE - Smart Order Timeout with Extensions (PRD 7777)
 * =============================================================================
 *
 * Exports smart timeout service and progress tracking.
 *
 * @module order-timeout
 */

export { smartTimeoutService } from './smart-timeout.service';
export { progressTrackingService } from './progress.service';

export type {
  SmartTimeoutConfig,
  OrderTimeoutState,
  ExtensionRequest,
  ExtensionResponse,
} from './smart-timeout.service';

export type {
  ProgressEventData,
  OrderProgressSummary,
  TruckAssignmentDetail,
} from './progress.service';
