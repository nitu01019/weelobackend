/**
 * =============================================================================
 * TRUCK HOLD MODULE
 * =============================================================================
 * 
 * BookMyShow-style truck holding system for broadcast orders.
 * 
 * EXPORTS:
 * - truckHoldService: Core service with hold/confirm/release logic
 * - truckHoldRouter: REST API routes
 * 
 * USAGE:
 *   import { truckHoldRouter, truckHoldService } from './modules/truck-hold';
 *   app.use('/api/v1/truck-hold', truckHoldRouter);
 * 
 * =============================================================================
 */

export { truckHoldService } from './truck-hold.service';
export { truckHoldRouter } from './truck-hold.routes';
