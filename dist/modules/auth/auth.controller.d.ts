/**
 * =============================================================================
 * AUTH MODULE - CONTROLLER
 * =============================================================================
 *
 * Handles HTTP requests for authentication.
 * Controller only handles request/response - business logic is in service.
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
declare class AuthController {
    /**
     * Send OTP to phone number
     */
    sendOtp: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Verify OTP and return tokens
     */
    verifyOtp: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Refresh access token
     */
    refreshToken: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Logout user
     */
    logout: (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Get current user info
     */
    getCurrentUser: (req: Request, res: Response, next: NextFunction) => void;
}
export declare const authController: AuthController;
export {};
//# sourceMappingURL=auth.controller.d.ts.map