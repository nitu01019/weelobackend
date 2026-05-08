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
 *
 * P1-T48 sizing rationale (A01-002, A01-007):
 * - flexHoldExtend = 10/min (~1 per 6s, bursty OK — extend is interactive UX)
 * - confirmedHoldInit = 5/min (SERIALIZABLE tx row-lock cost; 1 per ~12s)
 * - Both use blockDuration 120s which matches the new idempotency TTL
 *   (IDEMPOTENCY_TTL_SUCCESS_SECONDS = 240s in truck-hold.routes.ts): replays
 *   issued after a block clears still hit the idempotency cache within its
 *   TTL, so a legitimate retry after a block clears returns the cached result
 *   instead of re-executing.
 * - AWS API Gateway per-consumer throttling pattern.
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
  },

  // P1-T04 · A01-002 · Flex-hold extend: Max 10 per 60 seconds.
  // Extend is interactive (transporter clicks "extend" on a near-expiring hold);
  // 10/min = 1 per 6s is comfortably above any legitimate UX cadence.
  flexHoldExtend: {
    max: 10,
    window: 60,
    blockDuration: 120  // 2 minutes — aligned with IDEMPOTENCY_TTL_SUCCESS_SECONDS (see header)
  },

  // P1-T04 · A01-007 · Confirmed-hold initialize: Max 5 per 60 seconds.
  // Tight because transitionToConfirmed runs a SERIALIZABLE tx with row-level
  // locks on TruckHoldLedger; a spammy client at 20/min would queue behind its
  // own locks and starve pool capacity at 833 tx/s peak.
  confirmedHoldInit: {
    max: 5,
    window: 60,
    blockDuration: 120  // 2 minutes — matches idempotency cache window
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

      // Fix #31: Atomic Lua INCR+EXPIRE — single RTT, self-heals TTL=-1.
      // Critical for security counters: prevents an orphaned no-TTL counter from
      // bypassing the rate limit indefinitely.
      const { count: current, ttl: counterTtl } = await redisService.incrementWithTTLAndRemaining(counterKey, limit.window);

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
      res.setHeader('X-RateLimit-Reset', counterTtl.toString());

      // Proceed with request
      next();

    } catch (error: unknown) {
      // If Redis fails, reject the request (fail closed) to prevent abuse
      logger.error(`[RateLimit] Redis error, denying request for safety`, {
        action,
        transporterId,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(503).json({
        success: false,
        error: 'Rate limiting unavailable',
      });
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
  } catch (error: unknown) {
    logger.error('[RateLimit] Error checking status:', { error: error instanceof Error ? error.message : String(error) });
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
