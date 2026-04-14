/**
 * =============================================================================
 * SUSPENSION CHECK MIDDLEWARE
 * =============================================================================
 *
 * Checks whether the authenticated user is currently suspended.
 * If suspended, returns 403 with ACCOUNT_SUSPENDED code.
 *
 * IMPORTANT:
 * - Must be placed AFTER authMiddleware (needs req.user)
 * - Fails open on Redis errors (does not block users if Redis is down)
 * - Uses a fast EXISTS check (no JSON parsing in the hot path)
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { adminSuspensionService } from '../../modules/admin/admin-suspension.service';
import { logger } from '../services/logger.service';

/**
 * Middleware that blocks suspended users from accessing protected resources.
 * Place after authMiddleware on routes where suspension enforcement is needed.
 */
export async function suspensionCheckMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Skip if no authenticated user (let authMiddleware handle that)
  if (!req.user?.userId) {
    next();
    return;
  }

  try {
    const isSuspended = await adminSuspensionService.isUserSuspended(req.user.userId);
    if (isSuspended) {
      // Fetch full status for the response (reason, expiresAt)
      const status = await adminSuspensionService.getUserSuspensionStatus(req.user.userId);

      logger.warn('[SuspensionCheck] Suspended user blocked', {
        userId: req.user.userId,
        role: req.user.role,
        path: req.path,
        reason: status?.reason,
      });

      res.status(403).json({
        success: false,
        error: {
          code: 'ACCOUNT_SUSPENDED',
          message: 'Your account is currently suspended.',
          details: status
            ? {
                reason: status.reason,
                expiresAt: status.expiresAt,
                suspendedAt: status.suspendedAt,
              }
            : undefined,
        },
      });
      return;
    }
  } catch (err) {
    // Fail open: if Redis is down, allow the request through
    logger.warn('[SuspensionCheck] Check failed, allowing request', {
      userId: req.user.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  next();
}
