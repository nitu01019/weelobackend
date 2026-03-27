/**
 * =============================================================================
 * ASSIGNMENT MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for truck assignments.
 * Transporters create assignments, drivers accept/decline and update status.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { assignmentService } from './assignment.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateRequest } from '../../shared/utils/validation.utils';
import {
  createAssignmentSchema,
  updateStatusSchema,
  getAssignmentsQuerySchema
} from './assignment.schema';
import { prismaClient } from '../../shared/database/prisma.service';
const router = Router();

/**
 * @route   POST /assignments
 * @desc    Create assignment (Transporter assigns truck to booking)
 * @access  Transporter only
 */
router.post(
  '/',
  authMiddleware,
  roleGuard(['transporter']),
  validateRequest(createAssignmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assignment = await assignmentService.createAssignment(
        req.user!.userId,
        req.body
      );
      
      res.status(201).json({
        success: true,
        data: assignment
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /assignments
 * @desc    Get assignments (filtered by role)
 * @access  Transporter, Customer
 */
router.get(
  '/',
  authMiddleware,
  roleGuard(['transporter', 'customer']), // Defense-in-depth: explicit role restriction
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = getAssignmentsQuerySchema.parse(req.query);
      const result = await assignmentService.getAssignments(
        req.user!.userId,
        req.user!.role,
        query
      );
      
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /assignments/driver
 * @desc    Get driver's assignments
 * @access  Driver only
 */
router.get(
  '/driver',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = getAssignmentsQuerySchema.parse(req.query);
      const result = await assignmentService.getDriverAssignments(
        req.user!.userId,
        query
      );
      
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /assignments/driver/active
 * @desc    Get driver's active trips (supports both legacy bookingId and new orderId)
 * @access  Driver only
 *
 * Returns all active assignments regardless of whether they came from legacy booking system
 * or new multi-truck order system. Provides unified view for driver dashboard.
 */
router.get(
  '/driver/active',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driverId = req.user!.userId;

      // Industry Standard: Unified active trips view supports both legacy and new systems
      // - Backward compatible: existing bookings with bookingId
      // - Forward compatible: new orders with orderId
      const activeStatuses = [
        'driver_accepted',
        'en_route_pickup',
        'at_pickup',
        'in_transit',
        'arrived_at_drop'
      ];

      // Get assignments from legacy booking system
      const byBookingId = await prismaClient.assignment.findMany({
        where: {
          driverId,
          status: { in: activeStatuses as any },
          bookingId: { not: null }  // Legacy system
        },
        include: {
          booking: {
            select: { id: true, customerName: true }
          }
        }
      });

      // Get assignments from new multi-truck order system
      const byOrderId = await prismaClient.assignment.findMany({
        where: {
          driverId,
          status: { in: activeStatuses as any },
          orderId: { not: null }  // New system
        },
        include: {
          order: {
            select: { id: true, routePoints: true, customerName: true, customerPhone: true }
          }
        }
      });

      // Remove duplicates by tripId (industry standard for concurrent-safe dedup)
      const seenTripIds = new Set<string>();
      const allAssignments: any[] = [];

      for (const assignment of [...byBookingId, ...byOrderId]) {
        const tripKey = assignment.tripId;
        if (seenTripIds.has(tripKey)) continue;

        seenTripIds.add(tripKey);
        allAssignments.push({
          ...assignment,
          system: assignment.bookingId ? 'legacy' : 'multi-truck'
        });
      }

      res.json({
        success: true,
        data: {
          assignments: allAssignments,
          total: allAssignments.length,
          hasMore: false
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /assignments/:id
 * @desc    Get assignment by ID
 * @access  Transporter (own), Driver (assigned), Customer (own booking)
 */
router.get(
  '/:id',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assignment = await assignmentService.getAssignmentById(
        req.params.id,
        req.user!.userId,
        req.user!.role
      );
      
      res.json({
        success: true,
        data: assignment
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /assignments/:id/status
 * @desc    Get lightweight assignment status for TripStatusManagementScreen
 * @access  Transporter (own), Driver (assigned)
 *
 * Lightweight endpoint returning only essential fields for real-time status polling.
 * Industry Standard: Separate status endpoint from full detail endpoint reduces payload
 * and enables efficient real-time updates without fetching unnecessary data.
 *
 * @returns { success, data: { id, status, driverId, driverName, vehicleNumber, assignedAt, driverAcceptedAt, timeoutAt } }
 */
router.get(
  '/:id/status',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assignment = await prismaClient.assignment.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          status: true,
          driverId: true,
          transporterId: true,
          bookingId: true,
          driverName: true,
          vehicleNumber: true,
          assignedAt: true,
          driverAcceptedAt: true
        }
      });

      if (!assignment) {
        return res.status(404).json({
          success: false,
          error: 'Assignment not found'
        });
      }

      // Industry Standard: Uber/Stripe ownership check
      // Prevent IDOR - users can only access their own assignment status
      if (req.user!.role === 'driver' && assignment.driverId !== req.user!.userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Assignment not assigned to you'
        });
      }
      if (req.user!.role === 'transporter' && assignment.transporterId !== req.user!.userId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Assignment not under your transport'
        });
      }
      if (req.user!.role === 'customer') {
        const booking = await prismaClient.booking.findUnique({
          where: { id: assignment.bookingId },
          select: { customerId: true }
        });
        if (!booking || booking.customerId !== req.user!.userId) {
          return res.status(403).json({
            success: false,
            error: 'Access denied'
          });
        }
      }

      // Calculate timeout at (60 seconds from assignment) - Industry Standard
      const assignedAt = new Date(assignment.assignedAt);
      const timeoutAt = new Date(assignedAt.getTime() + 60000).toISOString();

      res.json({
        success: true,
        data: {
          ...assignment,
          timeoutAt
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PATCH /assignments/:id/accept
 * @desc    Accept assignment
 * @access  Driver only (assigned driver)
 */
router.patch(
  '/:id/accept',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assignment = await assignmentService.acceptAssignment(
        req.params.id,
        req.user!.userId
      );
      
      res.json({
        success: true,
        data: assignment
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PATCH /assignments/:id/decline
 * @desc    Decline assignment
 * @access  Driver only (assigned driver)
 */
router.patch(
  '/:id/decline',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Driver explicitly declines → notify transporter for reassignment
      // Uses declineAssignment (not cancelAssignment) for proper status + notifications
      await assignmentService.declineAssignment(
        req.params.id,
        req.user!.userId
      );
      
      res.json({
        success: true,
        message: 'Assignment declined'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PATCH /assignments/:id/status
 * @desc    Update assignment status (trip progress)
 * @access  Driver only (assigned driver)
 */
router.patch(
  '/:id/status',
  authMiddleware,
  roleGuard(['driver']),
  validateRequest(updateStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assignment = await assignmentService.updateStatus(
        req.params.id,
        req.user!.userId,
        req.body
      );
      
      res.json({
        success: true,
        data: assignment
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /assignments/:id
 * @desc    Cancel assignment
 * @access  Transporter only (own assignments)
 */
router.delete(
  '/:id',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assignmentService.cancelAssignment(
        req.params.id,
        req.user!.userId
      );
      
      res.json({
        success: true,
        message: 'Assignment cancelled'
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as assignmentRouter };
