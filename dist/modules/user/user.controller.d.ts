/**
 * =============================================================================
 * USER MODULE - CONTROLLER
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
declare class UserController {
    /**
     * Get current user profile
     */
    getProfile: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Update current user profile
     */
    updateProfile: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get user by ID (admin only)
     */
    getUserById: (req: Request, res: Response, next: NextFunction) => void;
}
export declare const userController: UserController;
export {};
//# sourceMappingURL=user.controller.d.ts.map