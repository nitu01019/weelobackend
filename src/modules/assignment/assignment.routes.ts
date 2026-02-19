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
