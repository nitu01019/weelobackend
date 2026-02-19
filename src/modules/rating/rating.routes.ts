import { Router, Request, Response } from 'express';
import { ratingService } from './rating.service';
import { submitRatingSchema, driverRatingsQuerySchema } from './rating.schema';
import { authenticate } from '../../shared/middleware/auth.middleware';
import { AppError } from '../../core/errors/AppError';
import { logger } from '../../shared/services/logger.service';
import { emitToUser } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';

const router = Router();

// All rating routes require authentication
router.use(authenticate);

// =============================================================================
// RATE LIMITER: Max 10 rating submissions per minute per user
// Redis-backed for distributed ECS instances. Graceful degradation if Redis down.
// =============================================================================
async function ratingRateLimit(userId: string): Promise<void> {
  try {
    const result = await redisService.checkRateLimit(`ratelimit:rating:${userId}`, 10, 60);
    if (!result.allowed) {
      throw new AppError(
        'Too many rating submissions. Please try again later.',
        429,
        'RATE_LIMITED'
      );
    }
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    // Redis down — allow request through (graceful degradation)
    logger.warn('[RATING] Rate limiter Redis error, allowing request', { error: error.message });
  }
}

// =============================================================================
// POST /api/v1/rating — Submit a rating for a completed trip
// Role: Customer only (validated at data level in service + route level here)
// =============================================================================
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    // Role isolation: Only customers can submit ratings
    if (userRole && userRole !== 'customer') {
      throw new AppError('Only customers can submit ratings', 403, 'ROLE_NOT_ALLOWED');
    }

    // Rate limit check
    await ratingRateLimit(userId);

    // Validate request body
    const parsed = submitRatingSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new AppError(firstError.message, 400, 'VALIDATION_ERROR');
    }

    const result = await ratingService.submitRating(userId, parsed.data);

    // Emit WebSocket event to driver for real-time dashboard update
    if (!result.idempotent && result.driverId) {
      try {
        emitToUser(result.driverId, 'driver_rating_updated', {
          newAvgRating: result.driverAvgRating,
          latestRating: {
            stars: result.stars
          }
        });
        logger.info('[RATING] WebSocket driver_rating_updated emitted', {
          driverId: result.driverId,
          newAvg: result.driverAvgRating
        });
      } catch (wsError: any) {
        // Best-effort: rating still succeeds if broadcast fails
        logger.warn('[RATING] WebSocket emission failed', { error: wsError.message });
      }
    }

    const statusCode = result.idempotent ? 200 : 201;
    // Don't expose driverId to customer in response
    const { driverId: _omit, ...safeResult } = result;
    res.status(statusCode).json({ success: true, data: safeResult });
  } catch (error: any) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message }
      });
    } else {
      logger.error('[RATING] Submit rating failed', {
        error: error.message,
        stack: error.stack?.substring(0, 300)
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to submit rating' }
      });
    }
  }
});

// =============================================================================
// GET /api/v1/rating/pending — Get unrated completed trips for the customer
// Role: Customer only
// =============================================================================
router.get('/pending', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    // Role isolation: Only customers have pending ratings
    if (userRole && userRole !== 'customer') {
      throw new AppError('Only customers can view pending ratings', 403, 'ROLE_NOT_ALLOWED');
    }

    const result = await ratingService.getPendingRatings(userId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message }
      });
    } else {
      logger.error('[RATING] Get pending ratings failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get pending ratings' }
      });
    }
  }
});

// =============================================================================
// GET /api/v1/rating/driver — Driver's own rating history (Captain app)
// Role: Driver only
// =============================================================================
router.get('/driver', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    // Role isolation: Only drivers can view their own ratings
    if (userRole && userRole !== 'driver') {
      throw new AppError('Only drivers can view their rating history', 403, 'ROLE_NOT_ALLOWED');
    }

    const parsed = driverRatingsQuerySchema.safeParse(req.query);
    const { page, limit } = parsed.success ? parsed.data : { page: 1, limit: 20 };

    const result = await ratingService.getDriverRatings(userId, page, limit);
    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message }
      });
    } else {
      logger.error('[RATING] Get driver ratings failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get rating history' }
      });
    }
  }
});

export default router;
