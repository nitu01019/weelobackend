/**
 * =============================================================================
 * AUTH MIDDLEWARE
 * =============================================================================
 * 
 * Authentication and authorization middleware.
 * 
 * SECURITY:
 * - Token validation on every request
 * - Role-based access control
 * - No trust by default
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/environment';
import { AppError } from '../types/error.types';
import { logger } from '../services/logger.service';

/**
 * User roles enum
 */
export enum UserRole {
  CUSTOMER = 'customer',
  TRANSPORTER = 'transporter',
  DRIVER = 'driver',
  ADMIN = 'admin'
}

/**
 * Extended Request type with user info
 */
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: string;
        phone: string;
      };
      userId?: string;
      userRole?: string;
      userPhone?: string;
    }
  }
}

/**
 * Auth middleware - validates JWT token
 * Must be applied to all protected routes
 */
export function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const token = authHeader.substring(7); // Remove 'Bearer '

    // Verify token
    const decoded = jwt.verify(token, config.jwt.secret) as {
      userId: string;
      role: string;
      phone: string;
    };

    // Attach user to request (both formats for compatibility)
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      phone: decoded.phone
    };
    // Legacy format for existing controllers
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.userPhone = decoded.phone;

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError(401, 'TOKEN_EXPIRED', 'Token has expired'));
    } else if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError(401, 'INVALID_TOKEN', 'Invalid token'));
    } else if (error instanceof AppError) {
      next(error);
    } else {
      logger.error('Auth middleware error', error);
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication failed'));
    }
  }
}

/**
 * Role guard - restricts access to specific roles
 * Must be used after authMiddleware
 * 
 * @param allowedRoles - Array of roles that can access the route
 */
export function roleGuard(allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('Access denied - insufficient role', {
        userId: req.user.userId,
        role: req.user.role,
        requiredRoles: allowedRoles,
        path: req.path
      });
      next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
      return;
    }

    next();
  };
}

/**
 * Authorize middleware - checks if user has required role
 * Alias for roleGuard for compatibility with existing code
 */
export function authorize(...allowedRoles: (string | UserRole)[]) {
  return roleGuard(allowedRoles.map(r => r.toString()));
}

/**
 * Authenticate middleware - alias for authMiddleware
 * For compatibility with existing code
 */
export const authenticate = authMiddleware;

/**
 * Optional auth middleware - validates token if present but doesn't require it
 * Useful for endpoints that work differently for authenticated vs anonymous users
 */
export function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token - continue without user
      next();
      return;
    }

    const token = authHeader.substring(7);
    
    const decoded = jwt.verify(token, config.jwt.secret) as {
      userId: string;
      role: string;
      phone: string;
    };

    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      phone: decoded.phone
    };
    // Legacy format for existing controllers
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.userPhone = decoded.phone;

    next();
  } catch (error) {
    // Invalid token - continue without user (don't fail)
    next();
  }
}

/**
 * Optional auth - alias for optionalAuthMiddleware
 */
export const optionalAuth = optionalAuthMiddleware;
