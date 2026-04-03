/**
 * =============================================================================
 * TRANSPORTER RATE LIMITING MIDDLEWARE
 * =============================================================================
 *
 * Prevents abuse and ensures fair usage across all transporters
 *
 * SCENARIO: One transporter spamming thousands of confirm-hold requests
 *           → Floods the system
 *           → Blocks legitimate traffic
 *           → Exceeds FCM quota
 *
 * SOLUTION: Per-transporter rate limits using Redis
 *           - Resets after time window
 *           - Blocks temporarily when exceeded
 *           - Allows legitimate high-volume usage
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';
import { redisService } from '../services/redis.service';

interface RateLimitConfig {
  max: number;           // Max requests allowed
  window: number;        // Time window in seconds
  blockDuration: number;  // Block time when exceeded
}

// Configured limits for different transporter actions
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Confirm hold with assignments: Max 20 per 60 seconds
  confirmHoldWithAssignments: {
    max: 20,
    window: 60,
    blockDuration: 300  // 5 minutes
  },

  // Hold trucks: Max 30 per 60 seconds
  holdTrucks: {
    max: 30,
    window: 60,
    blockDuration: 180  // 3 minutes
  },

  // Broadcast: Max 10 per 60 seconds
  broadcast: {
    max: 10,
    window: 60,
    blockDuration: 300  // 5 minutes
  },

  // Create assignment: Max 50 per 60 seconds
  createAssignment: {
    max: 50,
    window: 60,
    blockDuration: 300  // 5 minutes
  },

  // Update trip status: Max 100 per minute
  updateTripStatus: {
    max: 100,
    window: 60,
    blockDuration: 180
  },

  // Driver accept/decline assignment: Max 10 per 60 seconds
  // Tight limit — accept/decline is once-per-assignment action
  driverAcceptDecline: {
    max: 10,
    window: 60,
    blockDuration: 60  // 1 minute (short — don't lock driver out for long)
  }
};

/**
 * Create a rate limiting middleware for a specific action type
 *
 * @example
 * router.post('/confirm-with-assignments',
 *   authMiddleware,
 *   transporterRateLimit('confirmHoldWithAssignments'),
 *   yourHandler
 * );
 */
export function transporterRateLimit(action: keyof typeof RATE_LIMITS) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const transporterId = req.user!.userId;
    const role = req.user!.role;

    // Skip rate limiting for admin users
    if (role === 'admin') {
      return next();
    }

    const limit = RATE_LIMITS[action];
    if (!limit) {
      logger.warn(`No rate limit configured for action: ${action}`);
      return next();
    }

    // Redis keys
    const counterKey = `ratelimit:transporter:${action}:${transporterId}`;
    const blockKey = `ratelimit:blocked:${action}:${transporterId}`;

    try {
      // Check if currently blocked
      const isBlocked = await redisService.get(blockKey);
      if (isBlocked) {
        const ttl = await redisService.ttl(blockKey);

        logger.warn(`[RateLimit] Blocked transporter ${transporterId} on ${action} (blocked for ${ttl}s)`);

        return res.status(429).json({
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Too many ${action} requests. Please try again in ${ttl} seconds.`,
          retryAfter: ttl
        });
      }

      // Increment counter
      const current = await redisService.incr(counterKey);

      // Set expiry on first request
      if (current === 1) {
        await redisService.expire(counterKey, limit.window);
      }

      // Check if limit exceeded
      if (current > limit.max) {
        // Block this transporter
        await redisService.set(blockKey, '1', limit.blockDuration);
        logger.warn(`[RateLimit] Rate limit exceeded for transporter ${transporterId} on ${action} (${current}/${limit.max})`);

        return res.status(429).json({
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Maximum ${limit.max} ${action} requests per ${limit.window} seconds exceeded.`,
          retryAfter: limit.blockDuration
        });
      }

      // Add rate limit headers
      const remaining = Math.max(0, limit.max - current);
      res.setHeader('X-RateLimit-Limit', limit.max.toString());
      res.setHeader('X-RateLimit-Remaining', remaining.toString());
      res.setHeader('X-RateLimit-Reset', (await redisService.ttl(counterKey)).toString());

      // Proceed with request
      next();

    } catch (error: any) {
      // If Redis fails, allow the request (fail open)
      logger.error(`[RateLimit] Redis error, allowing request:`, error);
      next();
    }
  };
}

/**
 * Check rate limit status (for monitoring/health checks)
 */
export async function getRateLimitStatus(
  transporterId: string,
  action: keyof typeof RATE_LIMITS
): Promise<{
  current: number;
  max: number;
  remaining: number;
  resetTime: number | null;
  isBlocked: boolean;
  blockTimeRemaining: number | null;
}> {
  const limit = RATE_LIMITS[action];
  if (!limit) {
    throw new Error(`Unknown action: ${action}`);
  }

  const counterKey = `ratelimit:transporter:${action}:${transporterId}`;
  const blockKey = `ratelimit:blocked:${action}:${transporterId}`;

  try {
    const [current, ttl, blocked] = await Promise.all([
      redisService.get(counterKey),
      redisService.ttl(counterKey),
      redisService.get(blockKey)
    ]);

    return {
      current: parseInt(current || '0', 10),
      max: limit.max,
      remaining: Math.max(0, limit.max - parseInt(current || '0', 10)),
      resetTime: ttl,
      isBlocked: !!blocked,
      blockTimeRemaining: blocked ? await redisService.ttl(blockKey) : null
    };
  } catch (error: any) {
    logger.error('[RateLimit] Error checking status:', error);
    return {
      current: 0,
      max: limit.max,
      remaining: limit.max,
      resetTime: null,
      isBlocked: false,
      blockTimeRemaining: null
    };
  }
}
