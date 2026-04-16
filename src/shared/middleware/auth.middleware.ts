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
import { redisService } from '../services/redis.service';
import { prismaClient } from '../database/prisma.service';
import { metrics } from '../monitoring/metrics.service';
import { adminSuspensionService } from '../../modules/admin/admin-suspension.service';

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
        name?: string;
        jti?: string;
      };
      userId?: string;
      userRole?: string;
      userPhone?: string;
    }
  }
}

/**
 * Type guard: validates that a JWT payload has the expected shape.
 */
function isValidJwtPayload(p: unknown): p is { userId: string; role: string; phone?: string; jti?: string; deviceId?: string } {
  return (
    typeof p === 'object' &&
    p !== null &&
    'userId' in p &&
    typeof (p as Record<string, unknown>).userId === 'string' &&
    'role' in p &&
    typeof (p as Record<string, unknown>).role === 'string'
  );
}

// F-L5 FIX: Configurable fail policy when Redis is unavailable
// Set AUTH_REDIS_FAIL_POLICY=closed to reject requests when Redis is down (safer for high-security deployments).
// Default: 'open' — existing behavior, allows requests through with a warning.
const AUTH_REDIS_FAIL_POLICY = process.env.AUTH_REDIS_FAIL_POLICY || 'open';

// F-L5: Track consecutive Redis failures for auto-escalation
let consecutiveRedisFailures = 0;

/**
 * Auth middleware - validates JWT token
 * Must be applied to all protected routes
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const token = authHeader.substring(7); // Remove 'Bearer '

    // Verify token with algorithm restriction to prevent algorithm confusion attacks
    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });

    // Runtime validation of JWT payload shape
    if (!isValidJwtPayload(decoded)) {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid token payload');
    }

    // Check JTI blacklist for token revocation
    if (decoded.jti) {
      try {
        const isBlacklisted = await redisService.exists(`blacklist:${decoded.jti}`);
        if (isBlacklisted) {
          return next(new AppError(401, 'TOKEN_REVOKED', 'Token has been revoked'));
        }
      } catch (err) {
        consecutiveRedisFailures++;
        if (AUTH_REDIS_FAIL_POLICY === 'closed') {
          logger.error('[AUTH] Redis unavailable, rejecting request (fail-closed policy)', { userId: decoded.userId, path: req.path });
          return next(new AppError(503, 'SERVICE_UNAVAILABLE', 'Authentication service temporarily unavailable'));
        }
        logger.warn('[Auth] JTI blacklist check failed-open', { jti: decoded.jti, userId: decoded.userId, path: req.path });
        metrics.incrementCounter('auth_redis_failopen_total', { check_type: 'jti_blacklist' });
        if (consecutiveRedisFailures >= 10) {
          logger.error('CRITICAL: 10+ consecutive Redis auth failures — check Redis health', { consecutiveRedisFailures });
        }
      }
    }

    // F-A-10 FIX: Role-agnostic suspension check via canonical service helper.
    // Previously inlined `customer:suspended:{id}` key name that mismatched the
    // write path (`suspension:{id}` in adminSuspensionService), silently allowing
    // every suspended driver/transporter/admin to keep using the API.
    // Service-level helper fails open internally on Redis errors — we keep the
    // explicit catch so AUTH_REDIS_FAIL_POLICY=closed still takes effect.
    try {
      const isSuspended = await adminSuspensionService.isUserSuspended(decoded.userId);
      if (isSuspended) {
        return next(new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended'));
      }
    } catch (err) {
      consecutiveRedisFailures++;
      if (AUTH_REDIS_FAIL_POLICY === 'closed') {
        logger.error('[AUTH] Redis unavailable, rejecting request (fail-closed policy)', { userId: decoded.userId, path: req.path });
        return next(new AppError(503, 'SERVICE_UNAVAILABLE', 'Authentication service temporarily unavailable'));
      }
      logger.warn('[Auth] Suspension check failed-open', { userId: decoded.userId, path: req.path });
      metrics.incrementCounter('auth_redis_failopen_total', { check_type: 'suspension' });
      if (consecutiveRedisFailures >= 10) {
        logger.error('CRITICAL: 10+ consecutive Redis auth failures — check Redis health', { consecutiveRedisFailures });
      }
    }

    // F-L5: Reset consecutive failure counter on successful Redis path
    consecutiveRedisFailures = 0;

    // Resolve user name via Redis cache, falling back to DB lookup
    let userName: string | undefined;
    try {
      const cacheKey = `user:profile:${decoded.userId}`;
      const cached = await redisService.get(cacheKey);
      if (cached) {
        userName = cached;
      } else {
        const user = await prismaClient.user.findUnique({
          where: { id: decoded.userId },
          select: { name: true }
        });
        if (user?.name) {
          userName = user.name;
          await redisService.set(cacheKey, user.name, 300).catch(() => {});
        }
      }
    } catch (err) {
      // Non-blocking: if name lookup fails, proceed without it
      logger.warn('[Auth] User name lookup failed', { userId: decoded.userId, error: (err as Error).message });
    }

    // Attach user to request (both formats for compatibility)
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      phone: decoded.phone || '',
      name: userName,
      jti: decoded.jti
    };
    // Legacy format for existing controllers
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.userPhone = decoded.phone || '';

    // Device binding check: reject if token was issued for a different device.
    // Only enforced when BOTH the token carries a deviceId AND the request
    // includes an x-device-id header. This is backwards-compatible with
    // existing tokens that were issued before device binding was added.
    const tokenDeviceId = decoded.deviceId;
    const requestDeviceId = req.headers['x-device-id'];
    if (tokenDeviceId && requestDeviceId && tokenDeviceId !== requestDeviceId) {
      return next(new AppError(401, 'DEVICE_MISMATCH', 'Token was issued for a different device'));
    }

    next();
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError(401, 'TOKEN_EXPIRED', 'Token has expired'));
    } else if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError(401, 'INVALID_TOKEN', 'Invalid token'));
    } else if (error instanceof AppError) {
      next(error);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Auth middleware error', { error: msg });
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
export async function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token - continue without user
      next();
      return;
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });

    // Runtime validation of JWT payload shape
    if (!isValidJwtPayload(decoded)) {
      next();
      return;
    }

    // Check JTI blacklist for token revocation
    if (decoded.jti) {
      try {
        const isBlacklisted = await redisService.exists(`blacklist:${decoded.jti}`);
        if (isBlacklisted) {
          next(); // optional auth — just treat as unauthenticated instead of erroring
          return;
        }
      } catch (redisErr) {
        // Redis down — for optional auth, treat as unauthenticated
        logger.warn('optionalAuth Redis blacklist check failed', { path: req.path, error: (redisErr as Error).message });
        next();
        return;
      }
    }

    // F-A-10 FIX: Role-agnostic suspension check — treat suspended as unauthenticated.
    // Same canonical helper as authMiddleware so read/write share a single
    // Redis key prefix (`suspension:{id}`); prevents silent-allow on drivers,
    // transporters, and admins whose suspensions were stored under the new key.
    try {
      const isSuspended = await adminSuspensionService.isUserSuspended(decoded.userId);
      if (isSuspended) {
        next(); // suspended user = unauthenticated for optional auth
        return;
      }
    } catch (_err) {
      // Redis down — for optional auth, treat as unauthenticated
      next();
      return;
    }

    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      phone: decoded.phone || '',
      jti: decoded.jti
    };
    // Legacy format for existing controllers
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.userPhone = decoded.phone || '';

    next();
  } catch (err) {
    // Invalid token - continue without user (don't fail)
    logger.warn('optionalAuth JTI check failed', { path: req.path, error: (err as Error).message });
    next();
  }
}

/**
 * Optional auth - alias for optionalAuthMiddleware
 */
export const optionalAuth = optionalAuthMiddleware;
