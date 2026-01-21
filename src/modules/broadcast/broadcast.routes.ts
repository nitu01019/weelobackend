/**
 * =============================================================================
 * BROADCAST MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for broadcast management (booking requests sent to drivers).
 * 
 * FLOW:
 * 1. Customer creates booking → Backend creates broadcast
 * 2. Drivers see active broadcasts via GET /broadcasts/active
 * 3. Driver accepts → POST /broadcasts/:id/accept
 * 4. Driver declines → POST /broadcasts/:id/decline
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { broadcastService } from './broadcast.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';

const router = Router();

/**
 * @route   GET /broadcasts/active
 * @desc    Get active broadcasts for driver/transporter
 * @access  Driver, Transporter
 * @query   driverId, vehicleType (optional), maxDistance (optional)
 */
router.get(
  '/active',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { driverId, vehicleType, maxDistance } = req.query;
      
      const broadcasts = await broadcastService.getActiveBroadcasts({
        driverId: driverId as string || req.user!.userId,
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
      const { driverId, vehicleId, estimatedArrival, notes } = req.body;
      
      const result = await broadcastService.acceptBroadcast(
        req.params.broadcastId,
        {
          driverId: driverId || req.user!.userId,
          vehicleId,
          estimatedArrival,
          notes
        }
      );
      
      res.json({
        success: true,
        message: 'Broadcast accepted successfully',
        assignmentId: result.assignmentId,
        tripId: result.tripId,
        status: 'ASSIGNED'
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
