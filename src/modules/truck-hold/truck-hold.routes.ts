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
import { flexHoldService } from './flex-hold.service';
import { confirmedHoldService } from './confirmed-hold.service';
import { smartTimeoutService } from '../order-timeout/smart-timeout.service';
import { progressTrackingService } from '../order-timeout/progress.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { transporterRateLimit } from '../../shared/middleware/transporter-rate-limit.middleware';

const router = Router();

function mapHoldErrorToHttpStatus(code?: string): number {
  switch ((code || '').toUpperCase()) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'IDEMPOTENCY_CONFLICT':
      return 409;
    case 'NOT_ENOUGH_AVAILABLE':
    case 'ALREADY_HOLDING':
    case 'TRUCK_STATE_CHANGED':
    case 'ORDER_INACTIVE':
    case 'HOLD_EXPIRED':
      return 409;
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 400;
  }
}

function mapReleaseErrorToHttpStatus(code?: string): number {
  switch ((code || '').toUpperCase()) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'FORBIDDEN':
      return 403;
    case 'HOLD_NOT_FOUND':
      return 404;
    case 'IDEMPOTENCY_CONFLICT':
      return 409;
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 400;
  }
}

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
  transporterRateLimit('holdTrucks'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { orderId, vehicleType, vehicleSubtype } = req.body;
      const quantityRaw = req.body?.quantity;
      const quantityNumber = Number(quantityRaw);
      const idempotencyKey = (req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || '').trim() || undefined;
      
      // Validate required fields
      if (!orderId || !vehicleType || !Number.isFinite(quantityNumber)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'orderId, vehicleType, and quantity are required' }
        });
      }
      if (!Number.isInteger(quantityNumber) || quantityNumber <= 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'quantity must be a positive integer' }
        });
      }
      
      logger.info(`[TruckHoldRoutes] Hold request from ${transporterId}: ${quantityNumber}x ${vehicleType}`);
      
      const result = await truckHoldService.holdTrucks({
        orderId,
        transporterId,
        vehicleType,
        vehicleSubtype: vehicleSubtype || '',
        quantity: quantityNumber,
        idempotencyKey
      });
      
      if (result.success) {
        res.json({
          success: true,
          data: {
            holdId: result.holdId,
            expiresAt: result.expiresAt,
            heldQuantity: result.heldQuantity,
            holdState: result.holdState,
            eventId: result.eventId,
            eventVersion: result.eventVersion,
            serverTimeMs: result.serverTimeMs
          },
          message: result.message
        });
      } else {
        const status = mapHoldErrorToHttpStatus(result.error);
        res.status(status).json({
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
  transporterRateLimit('confirmHoldWithAssignments'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { holdId, assignments } = req.body;
      let idempotencyCacheKey: string | null = null;
      
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

      const idempotencyKey = (req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || '').trim();
      idempotencyCacheKey = idempotencyKey
        ? `idempotency:truck-hold:confirm:${transporterId}:${holdId}:${idempotencyKey}`
        : null;

      if (idempotencyCacheKey) {
        try {
          const cached = await redisService.getJSON<{ status: number; body: any }>(idempotencyCacheKey);
          if (cached) {
            return res.status(cached.status).json(cached.body);
          }
        } catch (cacheError: any) {
          logger.warn(`[TruckHoldRoutes] Idempotency read failed: ${cacheError?.message || 'unknown'}`);
        }
      }
      
      logger.info(`[TruckHoldRoutes] Confirm with assignments: ${holdId} by ${transporterId} (${assignments.length} trucks)`);
      
      const result = await truckHoldService.confirmHoldWithAssignments(
        holdId,
        transporterId,
        assignments
      );
      
      if (result.success) {
        const responseBody = {
          success: true,
          data: {
            assignmentIds: result.assignmentIds,
            tripIds: result.tripIds
          },
          message: result.message
        };
        if (idempotencyCacheKey) {
          await redisService.setJSON(idempotencyCacheKey, { status: 200, body: responseBody }, 120)
            .catch(() => {});
        }
        res.json(responseBody);
      } else {
        // Return 400 with detailed failure info
        const responseBody = {
          success: false,
          error: { 
            code: 'CONFIRM_FAILED', 
            message: result.message,
            failedAssignments: result.failedAssignments
          }
        };
        if (idempotencyCacheKey) {
          await redisService.setJSON(idempotencyCacheKey, { status: 400, body: responseBody }, 45)
            .catch(() => {});
        }
        res.status(400).json(responseBody);
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
      const idempotencyKey = (req.header('X-Idempotency-Key') || req.header('x-idempotency-key') || '').trim() || undefined;
      
      if (!holdId) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'holdId is required' }
        });
      }
      
      logger.info(`[TruckHoldRoutes] Release request: ${holdId} by ${transporterId}`);
      
      const result = await truckHoldService.releaseHold(holdId, transporterId, idempotencyKey);
      const status = result.success ? 200 : mapReleaseErrorToHttpStatus(result.error);
      res.status(status).json({
        success: result.success,
        message: result.message,
        error: result.success ? undefined : { code: result.error || 'RELEASE_FAILED', message: result.message }
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// GET MY ACTIVE HOLD (recovery endpoint for uncertain network responses)
// =============================================================================
router.get(
  '/my-active',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const orderId = String(req.query.orderId || '').trim();
      const vehicleType = String(req.query.vehicleType || '').trim();
      const vehicleSubtype = String(req.query.vehicleSubtype || '').trim();

      if (!orderId || !vehicleType) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'orderId and vehicleType are required' }
        });
      }

      const hold = await truckHoldService.getMyActiveHold(
        transporterId,
        orderId,
        vehicleType,
        vehicleSubtype
      );

      return res.json({
        success: true,
        data: hold,
        message: hold ? 'Active hold found' : 'No active hold'
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

// =============================================================================
// TWO-PHASE HOLD SYSTEM - FLEX HOLD (Phase 1) - PRD 7777
// =============================================================================

/**
 * @route   POST /truck-hold/flex-hold
 * @desc    Create a flex hold (Phase 1) - 90s base, auto-extend max 130s
 * @access  Transporter only
 *
 * @body    { orderId, vehicleType, vehicleSubtype, quantity, truckRequestIds }
 * @returns { success, holdId, expiresAt, remainingSeconds, canExtend }
 */
router.post(
  '/flex-hold',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { orderId, vehicleType, vehicleSubtype, quantity, truckRequestIds } = req.body;

      if (!orderId || !vehicleType || !vehicleSubtype || !quantity || !Array.isArray(truckRequestIds)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'All fields are required' }
        });
      }

      const result = await flexHoldService.createFlexHold({
        orderId,
        transporterId,
        vehicleType,
        vehicleSubtype,
        quantity: Number(quantity),
        truckRequestIds
      });

      res.status(result.success ? 201 : 400).json({
        success: result.success,
        data: result.success ? {
          holdId: result.holdId,
          phase: result.phase,
          expiresAt: result.expiresAt,
          remainingSeconds: result.remainingSeconds,
          canExtend: result.canExtend
        } : undefined,
        message: result.message,
        error: result.error ? { code: result.error } : undefined
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /truck-hold/flex-hold/extend
 * @desc    Extend a flex hold (auto +30s per driver assignment)
 * @access  Transporter only
 *
 * @body    { holdId, reason, driverId?, assignmentId? }
 * @returns { success, newExpiresAt, addedSeconds, extendedCount, canExtend }
 */
router.post(
  '/flex-hold/extend',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { holdId, reason, driverId, assignmentId } = req.body;

      if (!holdId) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'holdId is required' }
        });
      }

      const result = await flexHoldService.extendFlexHold({
        holdId,
        reason: reason || 'Driver assignment',
        driverId,
        assignmentId
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            newExpiresAt: result.newExpiresAt,
            addedSeconds: result.addedSeconds,
            extendedCount: result.extendedCount,
            canExtend: result.canExtend
          },
          message: result.message
        });
      } else {
        res.status(400).json({
          success: false,
          error: { code: result.error || 'EXTEND_FAILED', message: result.message }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /truck-hold/flex-hold/:holdId
 * @desc    Get flex hold state
 * @access  Transporter only
 *
 * @returns { holdId, phase, expiresAt, remainingSeconds, extendedCount, canExtend }
 */
router.get(
  '/flex-hold/:holdId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { holdId } = req.params;

      const state = await flexHoldService.getFlexHoldState(holdId);

      if (!state) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Flex hold not found' }
        });
      }

      res.json({
        success: true,
        data: state
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// TWO-PHASE HOLD SYSTEM - CONFIRMED HOLD (Phase 2) - PRD 7777
// =============================================================================

/**
 * @route   POST /truck-hold/confirmed-hold/initialize
 * @desc    Initialize a confirmed hold (transition from FLEX to Phase 2)
 * @access  Transporter only
 *
 * @body    { holdId, assignments: [{ assignmentId, driverId, truckRequestId }] }
 * @returns { success, message, confirmedExpiresAt }
 */
router.post(
  '/confirmed-hold/initialize',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporterId = req.user!.userId;
      const { holdId, assignments } = req.body;

      if (!holdId || !Array.isArray(assignments) || assignments.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'holdId and assignments are required' }
        });
      }

      const result = await confirmedHoldService.initializeConfirmedHold(holdId, assignments);

      if (result.success) {
        res.json({
          success: true,
          data: {
            confirmedExpiresAt: result.confirmedExpiresAt
          },
          message: result.message
        });
      } else {
        res.status(400).json({
          success: false,
          error: { code: 'INITIALIZE_FAILED', message: result.message }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /truck-hold/confirmed-hold/:holdId
 * @desc    Get confirmed hold state
 * @access  Transporter only
 *
 * @returns { holdId, phase, confirmedExpiresAt, remainingSeconds, trucksCount, trucksAccepted, trucksPending }
 */
router.get(
  '/confirmed-hold/:holdId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { holdId } = req.params;

      const state = await confirmedHoldService.getConfirmedHoldState(holdId);

      if (!state) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Confirmed hold not found' }
        });
      }

      res.json({
        success: true,
        data: state
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /truck-hold/driver/:assignmentId/accept
 * @desc    Driver accepts a trip assignment
 * @access  Driver only
 *
 * @returns { success, accepted, message }
 */
router.put(
  '/driver/:assignmentId/accept',
  authMiddleware,
  roleGuard(['driver']),
  transporterRateLimit('driverAcceptDecline'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      const { assignmentId } = req.params;

      const result = await confirmedHoldService.handleDriverAcceptance(assignmentId);

      res.status(result.success ? 200 : 400).json({
        success: result.success,
        data: {
          accepted: result.accepted,
          declined: result.declined,
          timeout: result.timeout
        },
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /truck-hold/driver/:assignmentId/decline
 * @desc    Driver declines a trip assignment
 * @access  Driver only
 *
 * @body    { reason }
 * @returns { success, declined, message }
 */
router.put(
  '/driver/:assignmentId/decline',
  authMiddleware,
  roleGuard(['driver']),
  transporterRateLimit('driverAcceptDecline'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;
      const { assignmentId } = req.params;
      const { reason } = req.body;

      const result = await confirmedHoldService.handleDriverDecline(assignmentId, reason);

      res.status(result.success ? 200 : 400).json({
        success: result.success,
        data: {
          accepted: result.accepted,
          declined: result.declined,
          timeout: result.timeout
        },
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  }
);

// =============================================================================
// Smart Order Timeout - PRD 7777
// =============================================================================

/**
 * @route   POST /truck-hold/order-timeout/initialize
 * @desc    Initialize smart order timeout (120s base, auto-extend)
 * @access  System only
 *
 * @body    { orderId, totalTrucks }
 * @returns { success, expiresAt }
 */
router.post(
  '/order-timeout/initialize',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId, totalTrucks } = req.body;

      if (!orderId || !totalTrucks) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'orderId and totalTrucks are required' }
        });
      }

      const result = await smartTimeoutService.initializeOrderTimeout(orderId, Number(totalTrucks));

      if (result.success) {
        res.json({
          success: true,
          data: {
            expiresAt: result.expiresAt
          }
        });
      } else {
        res.status(500).json({
          success: false,
          error: { code: 'INITIALIZE_FAILED', message: 'Failed to initialize order timeout' }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /truck-hold/order-timeout/extend
 * @desc    Extend order timeout on driver confirmation (+60s first, +30s each)
 * @access  System only
 *
 * @body    { orderId, driverId, driverName, assignmentId, truckRequestId?, isFirstDriver, reason }
 * @returns { success, newExpiresAt, addedSeconds, remainingSeconds }
 */
router.post(
  '/order-timeout/extend',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId, driverId, driverName, assignmentId, truckRequestId, isFirstDriver, reason } = req.body;

      if (!orderId || !driverId || !driverName || !assignmentId) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'orderId, driverId, driverName, and assignmentId are required' }
        });
      }

      const result = await smartTimeoutService.extendTimeout({
        orderId,
        driverId,
        driverName,
        assignmentId,
        truckRequestId,
        isFirstDriver: Boolean(isFirstDriver),
        reason: reason || 'Driver accepted trip'
      });

      res.status(result.success ? 200 : 400).json({
        success: result.success,
        data: result.success ? {
          newExpiresAt: result.newExpiresAt,
          addedSeconds: result.addedSeconds,
          totalExtendedSeconds: result.totalExtendedSeconds,
          remainingSeconds: result.remainingSeconds,
          isFirstExtension: result.isFirstExtension
        } : undefined,
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /truck-hold/order-timeout/:orderId
 * @desc    Get order timeout state
 * @access  Customer, Transporter, System
 *
 * @returns { orderId, baseTimeoutMs, extendedMs, totalTimeoutMs, expiresAt, remainingSeconds, isExpired }
 */
router.get(
  '/order-timeout/:orderId',
  authMiddleware,
  roleGuard(['customer', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;

      const state = await smartTimeoutService.getOrderTimeout(orderId);

      if (!state) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order timeout not found' }
        });
      }

      res.json({
        success: true,
        data: state
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /truck-hold/order-progress/:orderId
 * @desc    Get order progress for customer view (trucks assigned, extensions)
 * @access  Customer, Transporter
 *
 * @returns { orderId, trucksAssigned, trucksRemaining, progressPercent, timeExtendedBy, orderTimeout }
 */
router.get(
  '/order-progress/:orderId',
  authMiddleware,
  roleGuard(['customer', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;

      const progress = await smartTimeoutService.getOrderProgress(orderId);

      if (!progress) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order progress not found' }
        });
      }

      res.json({
        success: true,
        data: progress
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /truck-hold/order-assignments/:orderId
 * @desc    Get truck assignment details for an order
 * @access  Customer, Transporter
 *
 * @returns { orderId, assignments: [{ vehicleNumber, vehicleType, driverName, ... }] }
 */
router.get(
  '/order-assignments/:orderId',
  authMiddleware,
  roleGuard(['customer', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;

      const assignments = await progressTrackingService.getOrderAssignments(orderId);

      if (!assignments) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order assignments not found' }
        });
      }

      res.json({
        success: true,
        data: assignments
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as truckHoldRouter };
