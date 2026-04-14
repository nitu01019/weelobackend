/**
 * =============================================================================
 * SERVER ROUTE MOUNTING
 * =============================================================================
 *
 * Extracted from server.ts (file-split).
 * Mounts all API route modules, health routes, and debug routes.
 * =============================================================================
 */

import express from 'express';
import { config } from './config/environment';
import { db } from './shared/database/db';
import { logger } from './shared/services/logger.service';
import { getConnectedUserCount, getRedisAdapterStatus } from './shared/services/socket.service';
import { redisService } from './shared/services/redis.service';
import { healthRoutes } from './shared/routes/health.routes';
import { authMiddleware, roleGuard } from './shared/middleware/auth.middleware';

// Route modules
import { authRouter } from './modules/auth/auth.routes';
import { driverAuthRouter } from './modules/driver-auth/driver-auth.routes';
import { profileRouter } from './modules/profile/profile.routes';
import { vehicleRouter } from './modules/vehicle/vehicle.routes';
import { bookingRouter } from './modules/booking/booking.routes';
import { assignmentRouter } from './modules/assignment/assignment.routes';
import { trackingRouter } from './modules/tracking/tracking.routes';
import { pricingRouter } from './modules/pricing/pricing.routes';
import { driverRouter } from './modules/driver/driver.routes';
import { broadcastRouter } from './modules/broadcast/broadcast.routes';
import { notificationRouter } from './modules/notification/notification.routes';
import orderRouter from './modules/order/order.routes';
import transporterRouter from './modules/transporter/transporter.routes';
import { truckHoldRouter } from './modules/truck-hold';
import { customBookingRouter } from './modules/custom-booking';
import geocodingRouter from './modules/routing/geocoding.routes';
import customerRouter from './modules/customer/customer.routes';
import ratingRouter from './modules/rating/rating.routes';
import { adminRouter } from './modules/admin';

const API_PREFIX = '/api/v1';

/**
 * Mount health & monitoring routes BEFORE rate limiter so ALB checks pass.
 */
export function mountHealthRoutes(app: express.Application): void {
  app.use('/', healthRoutes);

  app.get('/health/runtime', authMiddleware, roleGuard(['admin']), async (_req, res) => {
    try {
      const stats = await db.getStats();
      const socketAdapter = getRedisAdapterStatus();
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv,
        version: '1.0.0',
        connectedUsers: getConnectedUserCount(),
        database: {
          users: stats.users,
          vehicles: stats.vehicles,
          bookings: stats.bookings,
          assignments: stats.assignments
        },
        redis: {
          connected: redisService.isConnected(),
          mode: redisService.isRedisEnabled() ? 'redis' : 'memory'
        },
        socket: {
          connectedUsers: getConnectedUserCount(),
          adapter: socketAdapter
        },
        security: {
          helmet: true,
          rateLimiting: true,
          inputSanitization: true,
          xssProtection: true
        }
      });
    } catch (error) {
      logger.warn('Runtime health stats unavailable', { error: error instanceof Error ? error.message : String(error) });
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv,
        version: '1.0.0',
        connectedUsers: getConnectedUserCount(),
        database: { unavailable: true }
      });
    }
  });
}

/**
 * Mount all API route modules.
 */
export function mountApiRoutes(app: express.Application): void {
  app.use(`${API_PREFIX}/auth`, authRouter);
  app.use(`${API_PREFIX}/driver-auth`, driverAuthRouter);
  app.use(`${API_PREFIX}/profile`, profileRouter);
  app.use(`${API_PREFIX}/customer`, customerRouter);
  app.use(`${API_PREFIX}/vehicles`, vehicleRouter);
  app.use(`${API_PREFIX}/bookings`, bookingRouter);
  app.use(`${API_PREFIX}/assignments`, assignmentRouter);
  app.use(`${API_PREFIX}/tracking`, trackingRouter);
  app.use(`${API_PREFIX}/pricing`, pricingRouter);
  app.use(`${API_PREFIX}/driver`, driverRouter);
  app.use(`${API_PREFIX}/broadcasts`, broadcastRouter);
  app.use(`${API_PREFIX}/orders`, orderRouter);
  app.use(`${API_PREFIX}/transporter`, transporterRouter);
  app.use(`${API_PREFIX}/notifications`, notificationRouter);
  app.use(`${API_PREFIX}/truck-hold`, truckHoldRouter);
  app.use(`${API_PREFIX}/custom-booking`, customBookingRouter);
  app.use(`${API_PREFIX}/geocoding`, geocodingRouter);
  app.use(`${API_PREFIX}/rating`, ratingRouter);

  // Admin routes (user suspension, warnings, audit)
  app.use(`${API_PREFIX}/admin`, adminRouter);
}

/**
 * Mount debug routes (development only) — protected by secret header.
 */
export function mountDebugRoutes(app: express.Application): void {
  if (!config.isDevelopment) return;

  // Require X-Debug-Secret header even in development to avoid accidental exposure
  const debugGuard = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const debugSecret = process.env.DEBUG_SECRET;
    if (!debugSecret || req.headers['x-debug-secret'] !== debugSecret) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };

  app.get(`${API_PREFIX}/debug/database`, debugGuard, async (_req, res) => {
    res.json({
      success: true,
      data: await db.getRawData()
    });
  });

  app.get(`${API_PREFIX}/debug/stats`, debugGuard, async (_req, res) => {
    res.json({
      success: true,
      data: await db.getStats()
    });
  });

  app.get(`${API_PREFIX}/debug/sockets`, debugGuard, (_req, res) => {
    const { getConnectionStats: getConnStats }: typeof import('./shared/services/socket.service') = require('./shared/services/socket.service');
    const debugStats = getConnStats();

    const connectedUsers: Array<{ socketId: string; userId: string; role: string; phone: string }> = [];
    const socketMod: typeof import('./shared/services/socket.service') = require('./shared/services/socket.service');
    const ioInstance = socketMod.getIO();
    if (ioInstance) {
      ioInstance.sockets.sockets.forEach((socket: { id: string; data: { userId: string; role: string; phone?: string } }) => {
        connectedUsers.push({
          socketId: socket.id,
          userId: socket.data.userId,
          role: socket.data.role,
          phone: socket.data.phone ? `***${String(socket.data.phone).slice(-4)}` : ''
        });
      });
    }

    res.json({
      success: true,
      data: {
        stats: debugStats,
        connectedUsers
      }
    });
  });
}
