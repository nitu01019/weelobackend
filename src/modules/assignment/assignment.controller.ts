/**
 * =============================================================================
 * ASSIGNMENT MODULE - CONTROLLER
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { assignmentService } from './assignment.service';
import { 
  createAssignmentSchema, 
  updateStatusSchema,
  getAssignmentsQuerySchema 
} from './assignment.schema';
import { validateSchema } from '../../shared/utils/validation.utils';
import { successResponse } from '../../shared/types/api.types';
import { asyncHandler } from '../../shared/middleware/error.middleware';

class AssignmentController {
  /**
   * Create new assignment (Transporter assigns truck to booking)
   */
  createAssignment = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const transporterId = req.userId!;
    const data = validateSchema(createAssignmentSchema, req.body);
    
    const assignment = await assignmentService.createAssignment(transporterId, data);
    
    res.status(201).json(successResponse({ assignment }));
  });

  /**
   * Get assignments (filtered by user role)
   */
  getAssignments = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.userId!;
    const userRole = req.userRole!;
    const query = validateSchema(getAssignmentsQuerySchema, req.query);
    
    const result = await assignmentService.getAssignments(userId, userRole, {
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20
    });
    
    res.json(successResponse(result.assignments, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      total: result.total,
      hasMore: result.hasMore
    }));
  });

  /**
   * Get driver's assignments
   */
  getDriverAssignments = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const driverId = req.userId!;
    const query = validateSchema(getAssignmentsQuerySchema, req.query);
    
    const result = await assignmentService.getDriverAssignments(driverId, {
      ...query,
      page: query.page ?? 1,
      limit: query.limit ?? 20
    });
    
    res.json(successResponse(result.assignments, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      total: result.total,
      hasMore: result.hasMore
    }));
  });

  /**
   * Get assignment by ID
   */
  getAssignmentById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const userId = req.userId!;
    const userRole = req.userRole!;
    
    const assignment = await assignmentService.getAssignmentById(id, userId, userRole);
    
    res.json(successResponse({ assignment }));
  });

  /**
   * Driver accepts assignment
   */
  acceptAssignment = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const driverId = req.userId!;
    
    const assignment = await assignmentService.acceptAssignment(id, driverId);
    
    res.json(successResponse({ assignment, message: 'Assignment accepted' }));
  });

  /**
   * Update assignment status
   */
  updateStatus = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const driverId = req.userId!;
    const data = validateSchema(updateStatusSchema, req.body);
    
    const assignment = await assignmentService.updateStatus(id, driverId, data);
    
    res.json(successResponse({ assignment }));
  });

  /**
   * Cancel assignment
   */
  cancelAssignment = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const transporterId = req.userId!;
    
    await assignmentService.cancelAssignment(id, transporterId);
    
    res.json(successResponse({ message: 'Assignment cancelled' }));
  });
}

export const assignmentController = new AssignmentController();
