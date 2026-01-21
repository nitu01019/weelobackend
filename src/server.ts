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
import { readFileSync, existsSync } from 'fs';

// Core imports
import { validateAndLogEnvironment } from './core/config/env.validation';

// Config & Services
import { config } from './config/environment';
import { logger } from './shared/services/logger.service';
import { initializeSocket, getConnectedUserCount, getConnectionStats } from './shared/services/socket.service';

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
import { cache } from './shared/middleware/cache.middleware';

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
import { healthRoutes } from './shared/routes/health.routes';
import { metricsMiddleware } from './shared/monitoring/metrics.service';
import { fcmService } from './shared/services/fcm.service';

// =============================================================================
// ENVIRONMENT VALIDATION (Fail fast if config is invalid)
// =============================================================================
validateAndLogEnvironment();

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
      minVersion: string;
      ciphers: string;
    } = {
      key: readFileSync(SSL_KEY_PATH),
      cert: readFileSync(SSL_CERT_PATH),
      // TLS 1.2 minimum (TLS 1.3 preferred)
      minVersion: 'TLSv1.2',
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

// Initialize FCM Service for Push Notifications
fcmService.initialize().then(() => {
  logger.info('📱 FCM Service initialized');
}).catch((err) => {
  logger.warn('⚠️ FCM Service initialization failed (push notifications disabled)', err);
});

// =============================================================================
// MIDDLEWARE - Security & Performance
// =============================================================================

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
app.use(cors({
  origin: config.isDevelopment ? '*' : [
    'https://weelo.app',
    'https://captain.weelo.app',
    /\.weelo\.app$/
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400 // 24 hours preflight cache
}));

// Parse JSON bodies with size limit
app.use(express.json({ limit: '10mb' }));

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

// Rate limiting
app.use(rateLimiter);

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/health', (_req, res) => {
  const stats = db.getStats();
  const cacheStats = cache.getStats();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    version: '1.0.0',
    connectedUsers: getConnectedUserCount(),
    database: {
      path: stats.dbPath,
      users: stats.users,
      vehicles: stats.vehicles,
      bookings: stats.bookings,
      assignments: stats.assignments
    },
    cache: {
      size: cacheStats.size,
      maxSize: cacheStats.maxSize,
      utilizationPercent: Math.round((cacheStats.size / cacheStats.maxSize) * 100)
    },
    security: {
      helmet: true,
      rateLimiting: true,
      inputSanitization: true,
      xssProtection: true
    }
  });
});

// =============================================================================
// API ROUTES
// =============================================================================

const API_PREFIX = '/api/v1';

// =============================================================================
// HEALTH & MONITORING ROUTES (No auth required)
// =============================================================================
app.use('/', healthRoutes);

// =============================================================================
// API ROUTES
// =============================================================================

// Auth routes (login, OTP) - Transporter & Customer
app.use(`${API_PREFIX}/auth`, authRouter);

// Driver Auth routes (separate auth for drivers)
app.use(`${API_PREFIX}/driver-auth`, driverAuthRouter);

// Profile routes (create/update profiles)
app.use(`${API_PREFIX}/profile`, profileRouter);

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

// =============================================================================
// DATABASE DEBUG ROUTES (Development only)
// =============================================================================

if (config.isDevelopment) {
  // View all data (for debugging)
  app.get(`${API_PREFIX}/debug/database`, (_req, res) => {
    res.json({
      success: true,
      data: db.getRawData()
    });
  });

  // View stats
  app.get(`${API_PREFIX}/debug/stats`, (_req, res) => {
    res.json({
      success: true,
      data: db.getStats()
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
// START SERVER
// =============================================================================

const PORT = config.port || 3000;

server.listen(PORT, '0.0.0.0', () => {
  const stats = db.getStats();
  const protocol = isHttps ? 'https' : 'http';
  const securityStatus = isHttps ? '🔒 SECURE (TLS 1.2+)' : '⚠️  HTTP (dev only)';
  
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                                                                    ║');
  console.log('║   🚛  WEELO UNIFIED BACKEND STARTED                                ║');
  console.log('║   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━     ║');
  console.log('║   Serving: 📱 Customer App  +  🚛 Captain App                      ║');
  console.log('║                                                                    ║');
  console.log('╠════════════════════════════════════════════════════════════════════╣');
  console.log(`║   📍 Server:      ${protocol}://localhost:${PORT}                           ║`);
  console.log(`║   📍 Environment: ${config.nodeEnv.padEnd(46)}║`);
  console.log(`║   🔐 Security:    ${securityStatus.padEnd(46)}║`);
  console.log('║                                                                    ║');
  console.log('║   📊 Database Stats:                                               ║');
  console.log(`║      • Users:       ${String(stats.users).padEnd(44)}║`);
  console.log(`║      • Vehicles:    ${String(stats.vehicles).padEnd(44)}║`);
  console.log(`║      • Bookings:    ${String(stats.bookings).padEnd(44)}║`);
  console.log('║                                                                    ║');
  console.log('║   🔗 Connect Apps:                                                 ║');
  console.log('║      • Android Emulator:  http://10.0.2.2:3000                     ║');
  console.log('║      • Physical Device:   http://<your-mac-ip>:3000               ║');
  console.log('║                                                                    ║');
  console.log('║   📚 API Modules:                                                  ║');
  console.log('║      • /api/v1/auth       - Login, OTP, JWT (Transporter/Customer) ║');
  console.log('║      • /api/v1/driver-auth- Driver Login (OTP to Transporter)      ║');
  console.log('║      • /api/v1/profile    - User profiles (all roles)              ║');
  console.log('║      • /api/v1/vehicles   - Vehicle management                     ║');
  console.log('║      • /api/v1/bookings   - Customer bookings                      ║');
  console.log('║      • /api/v1/assignments- Truck assignments                      ║');
  console.log('║      • /api/v1/tracking   - Real-time GPS                          ║');
  console.log('║      • /api/v1/pricing    - Fare estimation                        ║');
  console.log('║      • /api/v1/driver     - Driver dashboard                       ║');
  console.log('║      • /api/v1/broadcasts - Booking notifications                  ║');
  console.log('║                                                                    ║');
  console.log('║   📱 OTPs are logged to this console when requested               ║');
  console.log('║                                                                    ║');
  console.log('║   ❤️  Health Check: /health                                        ║');
  console.log('║                                                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log('');

  logger.info(`Server started on port ${PORT}`);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

const gracefulShutdown = (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    // Clear cache
    cache.clear();
    logger.info('Cache cleared');
    
    // Close database connections (if any)
    logger.info('Graceful shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// DEBUG: Socket connections endpoint
app.get('/api/v1/debug/sockets', (req, res) => {
  const { getConnectionStats } = require('./shared/services/socket.service');
  const stats = getConnectionStats();
  
  // Get all connected user IDs
  const connectedUsers: any[] = [];
  const io = require('./shared/services/socket.service').getIO();
  if (io) {
    io.sockets.sockets.forEach((socket: any) => {
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
      stats,
      connectedUsers
    }
  });
});
