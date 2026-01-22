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
// CONFIRM HOLD
// =============================================================================

/**
 * @route   POST /truck-hold/confirm
 * @desc    Confirm held trucks (assign them permanently)
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
      
      logger.info(`[TruckHoldRoutes] Confirm request: ${holdId} by ${transporterId}`);
      
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
