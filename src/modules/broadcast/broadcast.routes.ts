/**
 * =============================================================================
 * BROADCAST MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for legacy broadcast compatibility.
 * 
 * FLOW:
 * 1. Customer creates booking → Backend creates broadcast
 * 2. Canonical transporter feed is served by /bookings/requests/active.
 * 3. /broadcasts/* endpoints remain as compatibility aliases during migration.
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { broadcastService } from './broadcast.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateSchema } from '../../shared/utils/validation.utils';
import { logger } from '../../shared/services/logger.service';

const router = Router();

const acceptBroadcastBodySchema = z.object({
  driverId: z.string().uuid('Invalid driver ID').optional(),
  vehicleId: z.string().uuid('Invalid vehicle ID'),
  estimatedArrival: z.union([z.string(), z.number().int().min(1).max(720)]).optional(),
  notes: z.string().trim().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const idempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/, 'Invalid idempotency key format');

/**
 * @route   GET /broadcasts/active
 * @desc    Compatibility active feed for driver/transporter (legacy route)
 * @access  Driver, Transporter
 * @query   transporterId?, driverId?, vehicleType?, maxDistance?
 */
router.get(
  '/active',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { driverId, transporterId, vehicleType, maxDistance } = req.query;
      const actorId = (transporterId as string) || (driverId as string) || req.user!.userId;

      logger.info('[OrderIngress] active_broadcast_feed_request', {
        route_path: '/api/v1/broadcasts/active',
        route_alias_used: true,
        role: req.user!.role,
        actorId
      });
      
      const broadcasts = await broadcastService.getActiveBroadcasts({
        driverId: actorId,
        vehicleType: vehicleType as string,
        maxDistance: maxDistance ? parseFloat(maxDistance as string) : undefined
      });
      
      res.json({
        success: true,
        broadcasts,
        count: broadcasts.length
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /broadcasts/:broadcastId
 * @desc    Get broadcast details
 * @access  Driver, Transporter
 */
router.get(
  '/:broadcastId',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const broadcast = await broadcastService.getBroadcastById(req.params.broadcastId);
      
      res.json({
        success: true,
        broadcast
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /broadcasts/:broadcastId/accept
 * @desc    Accept a broadcast (driver accepts the trip)
 * @access  Driver, Transporter
 * @body    { driverId, vehicleId, estimatedArrival?, notes? }
 */
router.post(
  '/:broadcastId/accept',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = validateSchema(acceptBroadcastBodySchema, req.body);
      const idempotencyKeyHeader = req.header('X-Idempotency-Key');
      const idempotencyKey = idempotencyKeyHeader
        ? validateSchema(idempotencyKeyHeaderSchema, idempotencyKeyHeader)
        : undefined;
      const actorUserId = req.user!.userId;
      const actorRole = req.user!.role;
      const effectiveDriverId = actorRole === 'driver'
        ? actorUserId
        : (body.driverId || actorUserId);
      
      const result = await broadcastService.acceptBroadcast(
        req.params.broadcastId,
        {
          driverId: effectiveDriverId,
          vehicleId: body.vehicleId,
          estimatedArrival: body.estimatedArrival?.toString(),
          notes: body.notes,
          metadata: body.metadata,
          actorUserId,
          actorRole,
          idempotencyKey
        }
      );
      
      res.json({
        success: true,
        message: 'Broadcast accepted successfully',
        assignmentId: result.assignmentId,
        tripId: result.tripId,
        status: 'ASSIGNED',
        resultCode: result.resultCode || 'ASSIGNED',
        replayed: result.replayed === true
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /broadcasts/:broadcastId/decline
 * @desc    Decline a broadcast
 * @access  Driver, Transporter
 * @body    { driverId, reason, notes? }
 */
router.post(
  '/:broadcastId/decline',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { driverId, reason, notes } = req.body;
      
      await broadcastService.declineBroadcast(
        req.params.broadcastId,
        {
          driverId: driverId || req.user!.userId,
          reason,
          notes
        }
      );
      
      res.json({
        success: true,
        message: 'Broadcast declined'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /broadcasts/history
 * @desc    Get broadcast history for driver
 * @access  Driver, Transporter
 * @query   driverId, page, limit, status
 */
router.get(
  '/history',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { driverId, page = '1', limit = '20', status } = req.query;
      
      const result = await broadcastService.getBroadcastHistory({
        driverId: driverId as string || req.user!.userId,
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        status: status as string
      });
      
      res.json({
        success: true,
        broadcasts: result.broadcasts,
        pagination: result.pagination
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /broadcasts/create
 * @desc    Create broadcast (transporter only)
 * @access  Transporter
 */
router.post(
  '/create',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await broadcastService.createBroadcast({
        ...req.body,
        transporterId: req.user!.userId
      });
      
      res.status(201).json({
        success: true,
        broadcast: result.broadcast,
        notifiedDrivers: result.notifiedDrivers
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as broadcastRouter };
