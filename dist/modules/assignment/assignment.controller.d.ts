/**
 * =============================================================================
 * ASSIGNMENT MODULE - CONTROLLER
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
declare class AssignmentController {
    /**
     * Create new assignment (Transporter assigns truck to booking)
     */
    createAssignment: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get assignments (filtered by user role)
     */
    getAssignments: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get driver's assignments
     */
    getDriverAssignments: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get assignment by ID
     */
    getAssignmentById: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Driver accepts assignment
     */
    acceptAssignment: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Update assignment status
     */
    updateStatus: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Cancel assignment
     */
    cancelAssignment: (req: Request, res: Response, next: NextFunction) => void;
}
export declare const assignmentController: AssignmentController;
export {};
//# sourceMappingURL=assignment.controller.d.ts.map