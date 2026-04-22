/**
 * =============================================================================
 * BROADCAST MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for legacy broadcast compatibility.
 * 
 * FLOW:
 * 1. Customer creates booking → Backend creates broadcast
 * 2. Canonical transporter feed is served by /bookings/requests/active.
 * 3. /broadcasts/* endpoints remain as compatibility aliases during migration.
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { broadcastService } from './broadcast.service';
import { acceptBroadcast as acceptBroadcastSafe } from './broadcast-accept.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateSchema } from '../../shared/utils/validation.utils';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { AppError } from '../../shared/types/error.types';
import { buildAcceptResponse } from '../../shared/api-response.builder';
import { createHmac, randomBytes } from 'crypto';

// =============================================================================
// A09-007: Idempotency key helpers (local — truck-hold.routes.ts does not export these)
// =============================================================================

// 240s TTL aligned with IDEMPOTENCY_TTL_SUCCESS_SECONDS in truck-hold.routes.ts
const BROADCAST_IDEMPOTENCY_TTL_SUCCESS_SECONDS = 240;
// Server-generated keys use 30s TTL (short-lived; client-supplied keys keep full 240s)
const BROADCAST_SERVER_KEY_TTL_SECONDS = 30;
// HMAC secret for server-generated key signing — ensures the key was issued by this server
const HMAC_SECRET = process.env.IDEMPOTENCY_HMAC_SECRET || 'weelo-idem-fallback-secret';

/**
 * Read client-supplied X-Idempotency-Key header, or generate a server-issued key
 * with a `req-` prefix if none is present.
 * Server-generated keys are HMAC-signed so they can be validated on replay.
 */
function readOrGenerateIdempotencyKey(req: Request): { key: string; serverGenerated: boolean } {
  const headerVal = req.header('X-Idempotency-Key');
  if (headerVal && headerVal.trim().length >= 8) {
    return { key: headerVal.trim(), serverGenerated: false };
  }
  // Generate: req-<timestamp>-<8-byte random hex>-<hmac(8)>
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString('hex');
  const raw = `req-${ts}-${rand}`;
  const sig = createHmac('sha256', HMAC_SECRET).update(raw).digest('hex').slice(0, 8);
  const key = `${raw}-${sig}`;
  return { key, serverGenerated: true };
}

const router = Router();

const acceptBroadcastBodySchema = z.object({
  driverId: z.string().uuid('Invalid driver ID').optional(),
  vehicleId: z.string().uuid('Invalid vehicle ID'),
  estimatedArrival: z.union([z.string(), z.number().int().min(1).max(720)]).optional(),
  notes: z.string().trim().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const idempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/, 'Invalid idempotency key format');

// =============================================================================
// FIX #10: Per-user rate limiter for broadcast accept (10 requests per minute)
// Prevents abuse/flooding of Redis locks + DB serializable transactions.
// SAFETY: Fails open on Redis error (allows request through).
// =============================================================================
async function acceptRateLimiter(req: Request, _res: Response, next: NextFunction) {
  const userId = req.user?.userId;
  if (!userId) return next();
  const key = `rl:broadcast-accept:${userId}`;
  try {
    const count = await redisService.incr(key);
    if (count === 1) await redisService.expire(key, 60);
    if (count > 10) {
      return next(new AppError(429, 'RATE_LIMITED', 'Too many accept attempts. Please wait a moment.'));
    }
  } catch (err: any) {
    // Redis failure — fail open (allow request through)
    logger.warn('[RateLimit] Redis error in acceptRateLimiter', { error: err.message });
  }
  return next();
}

/**
 * @route   GET /broadcasts/active
 * @desc    Compatibility active feed for driver/transporter (legacy route)
 * @access  Driver, Transporter
 * @query   transporterId?, driverId?, vehicleType?, maxDistance?
 */
router.get(
  '/active',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // H-S3 FIX: Use authenticated user ID — never trust client-supplied actor IDs
      const { vehicleType, maxDistance } = req.query;
      const actorId = req.user!.userId;

      logger.info('[OrderIngress] active_broadcast_feed_request', {
        route_path: '/api/v1/broadcasts/active',
        route_alias_used: true,
        role: req.user!.role,
        actorId
      });

      // Fix E9: Add limit/offset pagination with max cap of 100
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const allBroadcasts = await broadcastService.getActiveBroadcasts({
        actorId,
        vehicleType: vehicleType as string,
        maxDistance: maxDistance ? parseFloat(maxDistance as string) : undefined
      });
      const total = allBroadcasts.length;
      const broadcasts = allBroadcasts.slice(offset, offset + limit);
      const syncCursor = new Date().toISOString();

      res.json({
        success: true,
        broadcasts,
        count: broadcasts.length,
        total,
        limit,
        offset,
        hasMore: offset + broadcasts.length < total,
        syncCursor
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /broadcasts/history
 * @desc    Get broadcast history for driver
 * @access  Driver, Transporter
 * @query   driverId, page, limit, status
 */
router.get(
  '/history',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // H-S3 FIX: Use authenticated user ID — never trust client-supplied driverId
      const { page = '1', limit = '20', status } = req.query;

      const result = await broadcastService.getBroadcastHistory({
        actorId: req.user!.userId,
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        status: status as string
      });

      res.json({
        success: true,
        broadcasts: result.broadcasts,
        pagination: result.pagination
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /broadcasts/:broadcastId
 * @desc    Get broadcast details
 * @access  Driver, Transporter
 */
router.get(
  '/:broadcastId',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const broadcast = await broadcastService.getBroadcastById(req.params.broadcastId);

      res.json({
        success: true,
        broadcast
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /broadcasts/:broadcastId/accept
 * @desc    Accept a broadcast (driver accepts the trip)
 * @access  Driver, Transporter
 * @body    { driverId, vehicleId, estimatedArrival?, notes? }
 */
router.post(
  '/:broadcastId/accept',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  acceptRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = validateSchema(acceptBroadcastBodySchema, req.body);
      // A09-007 (T11): Generate server key if client did not supply X-Idempotency-Key
      const { key: idempotencyKey, serverGenerated } = readOrGenerateIdempotencyKey(req);
      // Validate client-supplied keys against the schema; server-generated keys are already valid
      if (!serverGenerated) {
        validateSchema(idempotencyKeyHeaderSchema, idempotencyKey);
      }
      const actorUserId = req.user!.userId;
      const actorRole = req.user!.role;
      const effectiveDriverId = actorRole === 'driver'
        ? actorUserId
        : (body.driverId || actorUserId);

      const result = await acceptBroadcastSafe(
        req.params.broadcastId,
        {
          driverId: effectiveDriverId,
          vehicleId: body.vehicleId,
          estimatedArrival: body.estimatedArrival?.toString(),
          notes: body.notes,
          metadata: body.metadata,
          actorUserId,
          actorRole,
          idempotencyKey
        }
      );

      // A09-007 (T39): Always echo the idempotency key in the response header
      res.setHeader('X-Idempotency-Key', idempotencyKey);

      // F-M7: Use unified response builder (keeps backward-compatible top-level fields)
      const structured = buildAcceptResponse({
        assignmentId: result.assignmentId,
        tripId: result.tripId,
        status: 'ASSIGNED',
        resultCode: result.resultCode || 'ASSIGNED',
        replayed: result.replayed === true,
      });
      res.json({
        ...structured,
        // Backward-compatible top-level fields for existing clients
        assignmentId: result.assignmentId,
        tripId: result.tripId,
        status: 'ASSIGNED',
        resultCode: result.resultCode || 'ASSIGNED',
        replayed: result.replayed === true,
        // A09-007 (T39): Include idempotencyKey in response envelope
        idempotencyKey,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /broadcasts/:broadcastId/decline
 * @desc    Decline a broadcast
 * @access  Driver, Transporter
 * @body    { actorId, reason, notes? }
 */
router.post(
  '/:broadcastId/decline',
  authMiddleware,
  roleGuard(['driver', 'transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // H-S3 FIX: Use authenticated user ID — never trust client-supplied driverId
      const { reason, notes } = req.body;

      await broadcastService.declineBroadcast(
        req.params.broadcastId,
        {
          actorId: req.user!.userId,
          reason,
          notes
        }
      );

      res.json({
        success: true,
        message: 'Broadcast declined'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /broadcasts/create
 * @desc    DEPRECATED — Use POST /api/v1/bookings/orders instead
 * @access  Transporter
 */
router.post('/create', authMiddleware, (req: Request, res: Response) => {
  res.status(410).json({ success: false, error: 'ENDPOINT_DEPRECATED', message: 'Use POST /api/v1/bookings/orders instead' });
});

export { router as broadcastRouter };
