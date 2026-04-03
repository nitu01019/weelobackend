/**
 * =============================================================================
 * WEELO UNIFIED BACKEND - MAIN SERVER
 * =============================================================================
 * 
 * SINGLE BACKEND serving BOTH:
 *   📱 Weelo Customer App - For customers booking trucks
 *   🚛 Weelo Captain App  - For Transporters & Drivers
 * 
 * MODULES:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ AUTH       │ OTP-based login, JWT tokens, role-based access            │
 * │ PROFILE    │ Customer, Transporter, Driver profiles                    │
 * │ VEHICLE    │ Truck/Vehicle registration & management                   │
 * │ BOOKING    │ Customer booking requests                                 │
 * │ ASSIGNMENT │ Transporter assigns drivers/trucks to bookings            │
 * │ TRACKING   │ Real-time GPS location updates via WebSocket              │
 * │ PRICING    │ Fare estimation based on distance & vehicle type          │
 * │ DRIVER     │ Driver dashboard, earnings, availability                  │
 * │ BROADCAST  │ Push booking notifications to available drivers           │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * SECURITY:
 * - JWT authentication with refresh tokens
 * - Role-based access control (CUSTOMER, TRANSPORTER, DRIVER)
 * - Input validation using Zod schemas
 * - Rate limiting per IP/user
 * - Helmet security headers
 * 
 * SCALABILITY:
 * - Stateless design (ready for horizontal scaling)
 * - WebSocket for real-time without polling
 * - Database abstraction (swap JSON → PostgreSQL → any DB)
 * - Modular architecture (add/remove features easily)
 * 
 * =============================================================================
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { SecureVersion } from 'tls';
import { readFileSync, existsSync } from 'fs';

// Core imports
import { validateAndLogEnvironment } from './core/config/env.validation';

// Config & Services
import { config } from './config/environment';
import { logger } from './shared/services/logger.service';
import { initializeSocket, getConnectedUserCount, getConnectionStats, getRedisAdapterStatus } from './shared/services/socket.service';

// Middleware
import { errorHandler } from './shared/middleware/error.middleware';
import { requestLogger } from './shared/middleware/request-logger.middleware';
import { rateLimiter } from './shared/middleware/rate-limiter.middleware';
import {
  requestIdMiddleware,
  securityHeaders,
  sanitizeInput,
  preventParamPollution,
  blockSuspiciousRequests,
  securityResponseHeaders
} from './shared/middleware/security.middleware';
// import { cache } from './shared/middleware/cache.middleware'; // TODO: Create cache middleware

// Database
import { db } from './shared/database/db';

// Import route modules
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
import { registerHoldExpiryProcessor, holdExpiryCleanupService } from './modules/hold-expiry/hold-expiry-cleanup.service';
import { holdReconciliationService } from './modules/hold-expiry/hold-reconciliation.service';
import { customBookingRouter } from './modules/custom-booking';
import geocodingRouter from './modules/routing/geocoding.routes';
import { healthRoutes } from './shared/routes/health.routes';
import { metricsMiddleware } from './shared/monitoring/metrics.service';
import { fcmService } from './shared/services/fcm.service';
import { redisService } from './shared/services/redis.service';
import { startBookingExpiryChecker } from './modules/booking/booking.service';
import { startStaleTransporterCleanup } from './shared/services/transporter-online.service';

// =============================================================================
// Phase 10: SHUTDOWN STATE (shared with health.routes.ts)
// =============================================================================
let _isShuttingDown = false;
export function isShuttingDown(): boolean { return _isShuttingDown; }

// =============================================================================
// ENVIRONMENT VALIDATION (Fail fast if config is invalid)
// =============================================================================
validateAndLogEnvironment();

// =============================================================================
// REDIS + SERVER BOOTSTRAP (async — ensures Redis is ready before traffic)
// =============================================================================
// Moved into bootstrap() so the server does NOT accept traffic until Redis
// is connected and caches are warm. See Fix 2 / Fix 3 in REVIEW-REPORT.
// bootstrap() is invoked at the bottom of this file after all synchronous
// middleware and route registration.
// =============================================================================

// =============================================================================
// EXPRESS APP INITIALIZATION
// =============================================================================
const app = express();

// =============================================================================
// HTTPS/SSL CONFIGURATION
// =============================================================================

/**
 * SSL Certificate paths (for production)
 * 
 * In production, set these environment variables:
 * - SSL_KEY_PATH: Path to private key file (e.g., /etc/ssl/private/weelo.key)
 * - SSL_CERT_PATH: Path to certificate file (e.g., /etc/ssl/certs/weelo.crt)
 * - SSL_CA_PATH: Optional path to CA bundle (for intermediate certificates)
 * 
 * For Let's Encrypt certificates:
 * - SSL_KEY_PATH=/etc/letsencrypt/live/api.weelo.in/privkey.pem
 * - SSL_CERT_PATH=/etc/letsencrypt/live/api.weelo.in/fullchain.pem
 */
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || './certs/server.key';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || './certs/server.crt';
const SSL_CA_PATH = process.env.SSL_CA_PATH;

/**
 * Check if SSL certificates are available
 */
const hasSSLCertificates = (): boolean => {
  return existsSync(SSL_KEY_PATH) && existsSync(SSL_CERT_PATH);
};

/**
 * Create server (HTTPS in production, HTTP in development)
 */
let server: ReturnType<typeof createHttpServer | typeof createHttpsServer>;
let isHttps = false;

if (config.isProduction && hasSSLCertificates()) {
  // Production: Use HTTPS
  try {
    const sslOptions: {
      key: Buffer;
      cert: Buffer;
      ca?: Buffer;
      // Modern TLS settings
      minVersion: SecureVersion;
      ciphers: string;
    } = {
      key: readFileSync(SSL_KEY_PATH),
      cert: readFileSync(SSL_CERT_PATH),
      // TLS 1.2 minimum (TLS 1.3 preferred)
      minVersion: 'TLSv1.2' as SecureVersion,
      // Strong cipher suites only
      ciphers: [
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256'
      ].join(':')
    };

    // Add CA bundle if available (for intermediate certificates)
    if (SSL_CA_PATH && existsSync(SSL_CA_PATH)) {
      sslOptions.ca = readFileSync(SSL_CA_PATH);
    }

    server = createHttpsServer(sslOptions, app);
    isHttps = true;
    logger.info('🔒 HTTPS server created with TLS 1.2+');
  } catch (error) {
    logger.error('Failed to load SSL certificates, falling back to HTTP', error);
    server = createHttpServer(app);
  }
} else {
  // Development: Use HTTP
  server = createHttpServer(app);
  if (config.isProduction) {
    logger.warn('⚠️ Running in production without HTTPS! Set SSL_KEY_PATH and SSL_CERT_PATH');
  }
}

// Initialize Socket.IO
initializeSocket(server);

// Register hold expiry cleanup processor (Layer 1)
registerHoldExpiryProcessor();
logger.info('✅ Hold expiry cleanup processor registered (Layer 1)');

// Start hold reconciliation worker in production (Layer 2 - defense in depth)
if (process.env.NODE_ENV === 'production') {
  holdReconciliationService.start();
  logger.info('✅ Hold reconciliation worker started (Layer 2) - Periodic scans every 30s');
}

// Initialize FCM Service for Push Notifications
fcmService.initialize().then(() => {
  logger.info('📱 FCM Service initialized');
}).catch((err) => {
  logger.warn('⚠️ FCM Service initialization failed (push notifications disabled)', err);
});

// =============================================================================
// MIDDLEWARE - Security & Performance
// =============================================================================

// Trust proxy - MUST be first before any middleware that uses req.ip (rate limiter, etc.)
// Without this, req.ip returns ALB's internal IP — all users share one rate limit bucket.
app.set('trust proxy', 1);

// Request ID for tracking (must be first)
app.use(requestIdMiddleware);

// ⚡ GZIP Compression - Reduces response size by ~70%
app.use(compression({
  level: 6, // Balanced compression (1-9, 6 is optimal)
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress if client doesn't support it
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Security headers (Helmet)
app.use(securityHeaders);

// Additional security response headers
app.use(securityResponseHeaders);

// CORS - Configure based on environment
// Uses config.cors.origin from environment.ts for consistency
// H6 FIX: In production, if CORS_ORIGIN is not explicitly set, use restrictive default
// (empty array = block all cross-origin) instead of wildcard '*'.
const resolvedCorsOrigin = (() => {
  if (config.isDevelopment) return '*';
  if (config.cors.origin === '*' && config.isProduction) {
    logger.warn('[CORS] CORS_ORIGIN not set in production — defaulting to restrictive (no cross-origin). Set CORS_ORIGIN env var to allow specific origins.');
    return [] as string[];
  }
  return config.cors.origin;
})();

app.use(cors({
  origin: resolvedCorsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-ID',
    'X-Trace-ID',
    'X-Load-Test-Run-Id'
  ],
  credentials: true,
  maxAge: 86400 // 24 hours preflight cache
}));

// Parse JSON bodies with size limit
app.use(express.json({ limit: '1mb' }));

// Block suspicious requests (XSS, SQL injection, etc.)
app.use(blockSuspiciousRequests);

// Sanitize all input
app.use(sanitizeInput);

// Prevent parameter pollution
app.use(preventParamPollution);

// Request logging
app.use(requestLogger);

// Metrics collection middleware (track request duration, counts)
app.use(metricsMiddleware);

// =============================================================================
// HEALTH & MONITORING ROUTES - BEFORE rate limiter so ALB health checks never get throttled
// =============================================================================
app.use('/', healthRoutes);

app.get('/health/runtime', async (_req, res) => {
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

// Rate limiting - AFTER health routes so ALB health checks are never throttled
app.use(rateLimiter);

// =============================================================================
// API ROUTES
// =============================================================================

const API_PREFIX = '/api/v1';

// =============================================================================
// API ROUTES
// =============================================================================

// Auth routes (login, OTP) - Transporter & Customer
app.use(`${API_PREFIX}/auth`, authRouter);

// Driver Auth routes (separate auth for drivers)
app.use(`${API_PREFIX}/driver-auth`, driverAuthRouter);

// Profile routes (create/update profiles)
app.use(`${API_PREFIX}/profile`, profileRouter);

// Customer routes (wallet, trips, settings)
import customerRouter from './modules/customer/customer.routes';
app.use(`${API_PREFIX}/customer`, customerRouter);

// Vehicle routes (register trucks)
app.use(`${API_PREFIX}/vehicles`, vehicleRouter);

// Booking routes (customer bookings, transporter broadcasts)
app.use(`${API_PREFIX}/bookings`, bookingRouter);

// Assignment routes (assign trucks to bookings)
app.use(`${API_PREFIX}/assignments`, assignmentRouter);

// Tracking routes (live location)
app.use(`${API_PREFIX}/tracking`, trackingRouter);

// Pricing routes (fare estimation)
app.use(`${API_PREFIX}/pricing`, pricingRouter);

// Driver routes (dashboard, availability, earnings)
app.use(`${API_PREFIX}/driver`, driverRouter);

// Broadcast routes (booking broadcasts for drivers)
app.use(`${API_PREFIX}/broadcasts`, broadcastRouter);

// Multi-vehicle Order System (NEW)
app.use(`${API_PREFIX}/orders`, orderRouter);

// Transporter routes (availability, profile, stats)
app.use(`${API_PREFIX}/transporter`, transporterRouter);

// Notification routes (FCM token registration)
app.use(`${API_PREFIX}/notifications`, notificationRouter);

// Truck Hold System (BookMyShow-style holding)
app.use(`${API_PREFIX}/truck-hold`, truckHoldRouter);

// Custom Booking System (Long-term contracts)
app.use(`${API_PREFIX}/custom-booking`, customBookingRouter);

// Geocoding & Places Search (Google Maps integration)
app.use(`${API_PREFIX}/geocoding`, geocodingRouter);

// Rating routes (customer submits ratings, driver views ratings)
import ratingRouter from './modules/rating/rating.routes';
app.use(`${API_PREFIX}/rating`, ratingRouter);

// =============================================================================
// DATABASE DEBUG ROUTES (Development only)
// =============================================================================

if (config.isDevelopment) {
  // View all data (for debugging)
  app.get(`${API_PREFIX}/debug/database`, async (_req, res) => {
    res.json({
      success: true,
      data: await db.getRawData()
    });
  });

  // View stats
  app.get(`${API_PREFIX}/debug/stats`, async (_req, res) => {
    res.json({
      success: true,
      data: await db.getStats()
    });
  });

  // L6 FIX: Moved from after 404 handler to here (before it) so it's reachable
  // DEBUG: Socket connections endpoint
  // SECURITY: Only available in development — exposes connected user data
  app.get(`${API_PREFIX}/debug/sockets`, (_req, res) => {
    const { getConnectionStats: getConnStats }: typeof import('./shared/services/socket.service') = require('./shared/services/socket.service');
    const debugStats = getConnStats();

    // Get all connected user IDs
    const connectedUsers: any[] = [];
    const socketMod: typeof import('./shared/services/socket.service') = require('./shared/services/socket.service');
    const ioInstance = socketMod.getIO();
    if (ioInstance) {
      ioInstance.sockets.sockets.forEach((socket: any) => {
        connectedUsers.push({
          socketId: socket.id,
          userId: socket.data.userId,
          role: socket.data.role,
          phone: socket.data.phone
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

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found'
    }
  });
});

// Global error handler
app.use(errorHandler);

// =============================================================================
// START SERVER (via async bootstrap)
// =============================================================================

const PORT = config.port || 3000;

async function bootstrap(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Redis must be ready before we accept traffic
  // -------------------------------------------------------------------------
  try {
    await redisService.initialize();
    logger.info('RedisService initialized');
  } catch (err) {
    logger.error('RedisService initialization failed:', err);
    // Continue — redisService falls back to in-memory mode
  }

  // -------------------------------------------------------------------------
  // 2. Cache warming (non-blocking — failures are tolerable)
  // -------------------------------------------------------------------------
  // H3 geo index rebuild
  if (process.env.FF_H3_INDEX_ENABLED === 'true') {
    try {
      const { h3GeoIndexService } = await import('./shared/services/h3-geo-index.service');
      const geoKeys = await redisService.keys('geo:transporters:*');
      const vehicleKeys = geoKeys.map(k => k.replace('geo:transporters:', '')).filter(Boolean);

      if (vehicleKeys.length > 0) {
        const count = await h3GeoIndexService.rebuildFromGeoIndex(
          vehicleKeys,
          async (transporterId: string) => {
            const raw = await redisService.hGetAll(`transporter:details:${transporterId}`);
            if (!raw?.latitude || !raw?.longitude) return null;
            return {
              latitude: parseFloat(raw.latitude),
              longitude: parseFloat(raw.longitude),
              vehicleKeys: raw.vehicleKeys || ''
            };
          }
        );
        logger.info(`[CacheWarm] H3 index rebuilt: ${count} transporters indexed`);
      } else {
        logger.info('[CacheWarm] H3 rebuild skipped — no online transporters in Redis yet');
      }
    } catch (err: any) {
      logger.warn(`[CacheWarm] H3 rebuild failed (heartbeats will fill index): ${err.message}`);
    }
  }

  // Live availability rebuild
  try {
    const { liveAvailabilityService } = await import('./shared/services/live-availability.service');
    await liveAvailabilityService.rebuildFromDatabase();

    // Periodic reconciliation: compare Redis with DB every 5 minutes as a safety net
    // L1 FIX: unref() so this non-critical timer doesn't block process exit
    setInterval(() => {
      liveAvailabilityService.reconcile()
        .catch(err => logger.warn('[LiveAvail] Reconciliation failed:', (err as Error).message));
    }, 5 * 60 * 1000).unref();
  } catch (err: any) {
    logger.warn(`[LiveAvail] Bootstrap failed: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 3. Start background jobs that depend on Redis
  // -------------------------------------------------------------------------
  startBookingExpiryChecker();
  // M12 FIX: Explicitly start stale transporter cleanup (was auto-started on import)
  startStaleTransporterCleanup();
  // M12 FIX: Explicitly start driver offline checker (was auto-started on import)
  const { trackingService: trackingSvc } = await import('./modules/tracking/tracking.service');
  trackingSvc.startDriverOfflineChecker();

  // -------------------------------------------------------------------------
  // 4. Start listening for HTTP traffic
  // -------------------------------------------------------------------------
  await new Promise<void>((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      resolve();
    });
  });

  // Server timeouts — set after listen
  server.timeout = 30000;           // 30s max request time
  server.keepAliveTimeout = 65000;  // 65s > ALB idle timeout (60s)
  server.headersTimeout = 66000;    // 66s > keepAliveTimeout

  // Start cleanup job for expired orders (runs every 2 minutes)
  import('./shared/jobs/cleanup-expired-orders.job').then(({ startCleanupJob }) => {
    startCleanupJob();
  });

  // -------------------------------------------------------------------------
  // 5. Startup banner
  // -------------------------------------------------------------------------
  let stats: Awaited<ReturnType<typeof db.getStats>> = {
    users: 0,
    customers: 0,
    transporters: 0,
    drivers: 0,
    vehicles: 0,
    activeVehicles: 0,
    bookings: 0,
    activeBookings: 0,
    assignments: 0,
    dbType: 'unknown'
  };
  try {
    stats = await db.getStats();
  } catch (error) {
    logger.warn('Startup stats unavailable; continuing server boot', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  const protocol = isHttps ? 'https' : 'http';
  const securityStatus = isHttps ? '🔒 SECURE (TLS 1.2+)' : '⚠️  HTTP (dev only)';

  // M1-R FIX: Use logger instead of console.log for startup banner
  const banner = [
    '',
    'WEELO UNIFIED BACKEND STARTED',
    `  Server:      ${protocol}://localhost:${PORT}`,
    `  Environment: ${config.nodeEnv}`,
    `  Security:    ${securityStatus}`,
    `  Database:    Users=${stats.users} Vehicles=${stats.vehicles} Bookings=${stats.bookings}`,
    ''
  ].join('\n');
  logger.info(banner);

  logger.info(`Server started on port ${PORT}`);
}

bootstrap().catch((err) => {
  // console.error used intentionally — logger may not be initialized if bootstrap() failed early
  console.error('Bootstrap failed:', err);
  process.exit(1);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('Unhandled rejection', reason);

  // Guardrail for managed Redis modes that reject pub/sub commands.
  // We already fall back to no-adapter mode; don't crash the worker for this known case.
  const isKnownSocketPubSubCapabilityError =
    /unknown command 'psubscribe'/i.test(message) ||
    /socket\.io#\/#\*/i.test(message);
  if (isKnownSocketPubSubCapabilityError) {
    logger.warn('Ignoring known non-fatal Redis pub/sub capability error');
    return;
  }

  // Exit for unknown unhandled rejections to avoid corrupt process state.
  process.exit(1);
});

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Phase 10: Set shutdown flag — middleware returns 503, health returns 503
  _isShuttingDown = true;

  // Stop all background intervals first (prevents new work during shutdown)
  try {
    // H18 FIX: Add type annotations to lazy require() calls for type safety
    const { stopBookingExpiryChecker }: typeof import('./modules/booking/booking.service') = require('./modules/booking/booking.service');
    const { stopOrderExpiryChecker }: typeof import('./modules/booking/order.service') = require('./modules/booking/order.service');
    const { stopOrderTimerChecker }: typeof import('./modules/order/order.service') = require('./modules/order/order.service');
    // Assignment timeouts now use queue-based delayed jobs (no polling to stop)
    const { broadcastService }: typeof import('./modules/broadcast/broadcast.service') = require('./modules/broadcast/broadcast.service');
    const { stopStaleTransporterCleanup }: typeof import('./shared/services/transporter-online.service') = require('./shared/services/transporter-online.service');
    const { trackingService }: typeof import('./modules/tracking/tracking.service') = require('./modules/tracking/tracking.service');
    stopBookingExpiryChecker();
    stopOrderExpiryChecker();
    stopOrderTimerChecker();
    broadcastService?.stopExpiryChecker?.();
    stopStaleTransporterCleanup();
    trackingService?.stopDriverOfflineChecker?.();
    logger.info('All background intervals stopped');
  } catch (err) {
    logger.error('Error stopping background intervals', err);
  }

  // Phase 10 Issue 2: Graceful Socket.IO disconnect
  // Tell all connected clients "reconnect NOW" instead of silently dropping.
  // Clients already have reconnect logic — this triggers it immediately.
  try {
    const { getIO }: typeof import('./shared/services/socket.service') = require('./shared/services/socket.service');
    const io = getIO();
    if (io) {
      const socketCount = io.sockets.sockets.size;
      logger.info(`[Shutdown] Disconnecting ${socketCount} WebSocket client(s) with reason 'server_shutting_down'`);
      io.sockets.sockets.forEach((socket: any) => {
        socket.disconnect(true); // true = force close (sends 'disconnect' event with reason)
      });
      // Brief pause to let disconnect frames flush to clients
      await new Promise(resolve => setTimeout(resolve, 1000));
      logger.info('[Shutdown] All WebSocket clients disconnected');
    }
  } catch (err) {
    logger.error('Error disconnecting WebSocket clients', err);
  }

  server.close(async () => {
    logger.info('HTTP server closed');

    // Close Redis connection (flush pending operations)
    try {
      await redisService.shutdown();
      logger.info('Redis connection closed');
    } catch (err) {
      logger.error('Error closing Redis connection', err);
    }

    // Close Prisma/database connection pool
    try {
      const { prismaClient }: typeof import('./shared/database/prisma.service') = require('./shared/database/prisma.service');
      await prismaClient.$disconnect();
      logger.info('Database connection closed');
    } catch (err) {
      logger.error('Error closing database connection', err);
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  // L1 FIX: unref() so this doesn't prevent Node.js from exiting if everything else is done
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// L6 FIX: Debug socket route was here AFTER 404 handler — moved BEFORE it (see above)
