/**
 * =============================================================================
 * TRUCK HOLD ROUTES
 * =============================================================================
 * 
 * REST API endpoints for the truck hold system.
 * 
 * ENDPOINTS:
 * - POST /hold          - Hold trucks for selection
 * - POST /confirm       - Confirm held trucks
 * - POST /release       - Release/reject held trucks
 * - GET  /availability  - Get real-time truck availability
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { truckHoldService } from './truck-hold.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { logger } from '../../shared/services/logger.service';

const router = Router();

// =============================================================================
// HOLD TRUCKS
// =============================================================================

/**
 * @route   POST /truck-hold/hold
 * @desc    Hold trucks for a specific vehicle type
 * @access  Transporter only
 * 
 * @body    { orderId, vehicleType, vehicleSubtype, quantity }
 * @returns { success, holdId, expiresAt, heldQuantity, message }
 */
router.post(
  '/hold',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { orderId, vehicleType, vehicleSubtype, quantity } = req.body;
      
      // Validate required fields
      if (!orderId || !vehicleType || !quantity) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'orderId, vehicleType, and quantity are required' }
        });
      }
      
      logger.info(`[TruckHoldRoutes] Hold request from ${transporterId}: ${quantity}x ${vehicleType}`);
      
      const result = await truckHoldService.holdTrucks({
        orderId,
        transporterId,
        vehicleType,
        vehicleSubtype: vehicleSubtype || '',
        quantity: parseInt(quantity, 10)
      });
      
      if (result.success) {
        res.json({
          success: true,
          data: {
            holdId: result.holdId,
            expiresAt: result.expiresAt,
            heldQuantity: result.heldQuantity
          },
          message: result.message
        });
      } else {
        res.status(400).json({
          success: false,
          error: { code: result.error, message: result.message }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// CONFIRM HOLD (Simple)
// =============================================================================

/**
 * @route   POST /truck-hold/confirm
 * @desc    Confirm held trucks (simple - without vehicle/driver assignment)
 * @access  Transporter only
 * 
 * @body    { holdId }
 * @returns { success, assignedTrucks, message }
 */
router.post(
  '/confirm',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { holdId } = req.body;
      
      if (!holdId) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'holdId is required' }
        });
      }
      
      logger.info(`[TruckHoldRoutes] Simple confirm request: ${holdId} by ${transporterId}`);
      
      const result = await truckHoldService.confirmHold(holdId, transporterId);
      
      if (result.success) {
        res.json({
          success: true,
          data: { assignedTrucks: result.assignedTrucks },
          message: result.message
        });
      } else {
        res.status(400).json({
          success: false,
          error: { code: 'CONFIRM_FAILED', message: result.message }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// CONFIRM HOLD WITH ASSIGNMENTS (Full flow with vehicle + driver)
// =============================================================================

/**
 * @route   POST /truck-hold/confirm-with-assignments
 * @desc    Confirm held trucks with vehicle and driver assignments
 * @access  Transporter only
 * 
 * This is the PRODUCTION endpoint that:
 * 1. Validates vehicle availability (not in another trip)
 * 2. Validates driver availability (not on another trip)
 * 3. Creates assignment records
 * 4. Updates vehicle status to 'in_transit'
 * 5. Notifies drivers and customer
 * 
 * CORE INVARIANTS ENFORCED:
 * - One truck can be assigned to only one active order
 * - One driver can be on only one active trip
 * - Atomic: all assignments succeed or none
 * 
 * @body    { 
 *   holdId: string,
 *   assignments: [{ vehicleId: string, driverId: string }, ...]
 * }
 * @returns { 
 *   success: boolean,
 *   data?: { assignmentIds: string[], tripIds: string[] },
 *   message: string,
 *   failedAssignments?: [{ vehicleId: string, reason: string }, ...]
 * }
 */
router.post(
  '/confirm-with-assignments',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { holdId, assignments } = req.body;
      
      // Validate required fields
      if (!holdId) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'holdId is required' }
        });
      }
      
      if (!assignments || !Array.isArray(assignments) || assignments.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'assignments array is required' }
        });
      }
      
      // Validate each assignment has vehicleId and driverId
      for (let i = 0; i < assignments.length; i++) {
        const { vehicleId, driverId } = assignments[i];
        if (!vehicleId || !driverId) {
          return res.status(400).json({
            success: false,
            error: { 
              code: 'VALIDATION_ERROR', 
              message: `Assignment ${i + 1} is missing vehicleId or driverId` 
            }
          });
        }
      }
      
      logger.info(`[TruckHoldRoutes] Confirm with assignments: ${holdId} by ${transporterId} (${assignments.length} trucks)`);
      
      const result = await truckHoldService.confirmHoldWithAssignments(
        holdId,
        transporterId,
        assignments
      );
      
      if (result.success) {
        res.json({
          success: true,
          data: {
            assignmentIds: result.assignmentIds,
            tripIds: result.tripIds
          },
          message: result.message
        });
      } else {
        // Return 400 with detailed failure info
        res.status(400).json({
          success: false,
          error: { 
            code: 'CONFIRM_FAILED', 
            message: result.message,
            failedAssignments: result.failedAssignments
          }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// RELEASE HOLD
// =============================================================================

/**
 * @route   POST /truck-hold/release
 * @desc    Release/reject held trucks (make them available again)
 * @access  Transporter only
 * 
 * @body    { holdId }
 * @returns { success, message }
 */
router.post(
  '/release',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { holdId } = req.body;
      
      if (!holdId) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'holdId is required' }
        });
      }
      
      logger.info(`[TruckHoldRoutes] Release request: ${holdId} by ${transporterId}`);
      
      const result = await truckHoldService.releaseHold(holdId, transporterId);
      
      res.json({
        success: result.success,
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// GET AVAILABILITY
// =============================================================================

/**
 * @route   GET /truck-hold/availability/:orderId
 * @desc    Get real-time truck availability for an order
 * @access  Transporter only
 * 
 * @returns { orderId, trucks: [{ vehicleType, available, held, assigned }], ... }
 */
router.get(
  '/availability/:orderId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      
      const availability = await truckHoldService.getOrderAvailability(orderId);
      
      if (!availability) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' }
        });
      }
      
      res.json({
        success: true,
        data: availability
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as truckHoldRouter };
