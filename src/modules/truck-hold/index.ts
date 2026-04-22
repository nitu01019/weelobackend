/**
 * =============================================================================
 * TRUCK HOLD MODULE - Two-Phase Truck Hold System (PRD 7777)
 * =============================================================================
 *
 * BookMyShow-style truck holding system with two-phase hold:
 * - Phase 1 (FLEX): 90s base, auto-extend +30s per driver, max 130s
 * - Phase 2 (CONFIRMED): Max 180s, trucks locked
 *
 * EXPORTS:
 * - truckHoldService: Core service with hold/confirm/release logic
 * - truckHoldRouter: REST API routes
 * - flexHoldService: Phase 1 flex hold service (NEW - PRD 7777)
 * - confirmedHoldService: Phase 2 confirmed hold service (NEW - PRD 7777)
 *
 * USAGE:
 *   import { truckHoldRouter, truckHoldService, flexHoldService, confirmedHoldService } from './modules/truck-hold';
 *   app.use('/api/v1/truck-hold', truckHoldRouter);
 *
 * =============================================================================
 */

export { truckHoldService } from './truck-hold.service';
export { truckHoldRouter } from './truck-hold.routes';
export { flexHoldService } from './flex-hold.service';
export { confirmedHoldService } from './confirmed-hold.service';

export type {
  FlexHoldConfig,
  FlexHoldState,
  CreateFlexHoldRequest,
  FlexHoldResponse,
  ExtendFlexHoldRequest,
  ExtendHoldHoldResponse,
} from './flex-hold.service';

export type {
  ConfirmedHoldConfig,
  ConfirmedHoldState,
  DriverAcceptResponse,
} from './confirmed-hold.service';

// A01-001 · CI guard: the lifecycle router is orphan by design; it must
//   never be mounted. Importing IS_ORPHAN_ROUTER here lets a Jest test
//   assert that this module does not re-export the lifecycle router.
export { IS_ORPHAN_ROUTER as _TRUCK_HOLD_LIFECYCLE_IS_ORPHAN } from './truck-hold-lifecycle.routes';
