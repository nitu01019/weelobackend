"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const compression_1 = __importDefault(require("compression"));
const http_1 = require("http");
const https_1 = require("https");
const fs_1 = require("fs");
const environment_1 = require("./config/environment");
const logger_service_1 = require("./shared/services/logger.service");
const socket_service_1 = require("./shared/services/socket.service");
const error_middleware_1 = require("./shared/middleware/error.middleware");
const request_logger_middleware_1 = require("./shared/middleware/request-logger.middleware");
const rate_limiter_middleware_1 = require("./shared/middleware/rate-limiter.middleware");
const db_1 = require("./shared/database/db");
const security_middleware_1 = require("./shared/middleware/security.middleware");
const cache_middleware_1 = require("./shared/middleware/cache.middleware");
// Import route modules
const auth_routes_1 = require("./modules/auth/auth.routes");
const driver_auth_routes_1 = require("./modules/driver-auth/driver-auth.routes");
const profile_routes_1 = require("./modules/profile/profile.routes");
const vehicle_routes_1 = require("./modules/vehicle/vehicle.routes");
const booking_routes_1 = require("./modules/booking/booking.routes");
const assignment_routes_1 = require("./modules/assignment/assignment.routes");
const tracking_routes_1 = require("./modules/tracking/tracking.routes");
const pricing_routes_1 = require("./modules/pricing/pricing.routes");
const driver_routes_1 = require("./modules/driver/driver.routes");
const broadcast_routes_1 = require("./modules/broadcast/broadcast.routes");
const notification_routes_1 = require("./modules/notification/notification.routes");
const order_routes_1 = __importDefault(require("./modules/order/order.routes"));
const transporter_routes_1 = __importDefault(require("./modules/transporter/transporter.routes"));
const fcm_service_1 = require("./shared/services/fcm.service");
const app = (0, express_1.default)();
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
const hasSSLCertificates = () => {
    return (0, fs_1.existsSync)(SSL_KEY_PATH) && (0, fs_1.existsSync)(SSL_CERT_PATH);
};
/**
 * Create server (HTTPS in production, HTTP in development)
 */
let server;
let isHttps = false;
if (environment_1.config.isProduction && hasSSLCertificates()) {
    // Production: Use HTTPS
    try {
        const sslOptions = {
            key: (0, fs_1.readFileSync)(SSL_KEY_PATH),
            cert: (0, fs_1.readFileSync)(SSL_CERT_PATH),
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
        if (SSL_CA_PATH && (0, fs_1.existsSync)(SSL_CA_PATH)) {
            sslOptions.ca = (0, fs_1.readFileSync)(SSL_CA_PATH);
        }
        server = (0, https_1.createServer)(sslOptions, app);
        isHttps = true;
        logger_service_1.logger.info('🔒 HTTPS server created with TLS 1.2+');
    }
    catch (error) {
        logger_service_1.logger.error('Failed to load SSL certificates, falling back to HTTP', error);
        server = (0, http_1.createServer)(app);
    }
}
else {
    // Development: Use HTTP
    server = (0, http_1.createServer)(app);
    if (environment_1.config.isProduction) {
        logger_service_1.logger.warn('⚠️ Running in production without HTTPS! Set SSL_KEY_PATH and SSL_CERT_PATH');
    }
}
// Initialize Socket.IO
(0, socket_service_1.initializeSocket)(server);
// Initialize FCM Service for Push Notifications
fcm_service_1.fcmService.initialize().then(() => {
    logger_service_1.logger.info('📱 FCM Service initialized');
}).catch((err) => {
    logger_service_1.logger.warn('⚠️ FCM Service initialization failed (push notifications disabled)', err);
});
// =============================================================================
// MIDDLEWARE - Security & Performance
// =============================================================================
// Request ID for tracking (must be first)
app.use(security_middleware_1.requestIdMiddleware);
// ⚡ GZIP Compression - Reduces response size by ~70%
app.use((0, compression_1.default)({
    level: 6, // Balanced compression (1-9, 6 is optimal)
    threshold: 1024, // Only compress responses > 1KB
    filter: (req, res) => {
        // Don't compress if client doesn't support it
        if (req.headers['x-no-compression'])
            return false;
        return compression_1.default.filter(req, res);
    }
}));
// Security headers (Helmet)
app.use(security_middleware_1.securityHeaders);
// Additional security response headers
app.use(security_middleware_1.securityResponseHeaders);
// CORS - Configure based on environment
app.use((0, cors_1.default)({
    origin: environment_1.config.isDevelopment ? '*' : [
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
app.use(express_1.default.json({ limit: '10mb' }));
// Block suspicious requests (XSS, SQL injection, etc.)
app.use(security_middleware_1.blockSuspiciousRequests);
// Sanitize all input
app.use(security_middleware_1.sanitizeInput);
// Prevent parameter pollution
app.use(security_middleware_1.preventParamPollution);
// Request logging
app.use(request_logger_middleware_1.requestLogger);
// Rate limiting
app.use(rate_limiter_middleware_1.rateLimiter);
// =============================================================================
// HEALTH CHECK
// =============================================================================
app.get('/health', (_req, res) => {
    const stats = db_1.db.getStats();
    const cacheStats = cache_middleware_1.cache.getStats();
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: environment_1.config.nodeEnv,
        version: '1.0.0',
        connectedUsers: (0, socket_service_1.getConnectedUserCount)(),
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
// Auth routes (login, OTP) - Transporter & Customer
app.use(`${API_PREFIX}/auth`, auth_routes_1.authRouter);
// Driver Auth routes (separate auth for drivers)
app.use(`${API_PREFIX}/driver-auth`, driver_auth_routes_1.driverAuthRouter);
// Profile routes (create/update profiles)
app.use(`${API_PREFIX}/profile`, profile_routes_1.profileRouter);
// Vehicle routes (register trucks)
app.use(`${API_PREFIX}/vehicles`, vehicle_routes_1.vehicleRouter);
// Booking routes (customer bookings, transporter broadcasts)
app.use(`${API_PREFIX}/bookings`, booking_routes_1.bookingRouter);
// Assignment routes (assign trucks to bookings)
app.use(`${API_PREFIX}/assignments`, assignment_routes_1.assignmentRouter);
// Tracking routes (live location)
app.use(`${API_PREFIX}/tracking`, tracking_routes_1.trackingRouter);
// Pricing routes (fare estimation)
app.use(`${API_PREFIX}/pricing`, pricing_routes_1.pricingRouter);
// Driver routes (dashboard, availability, earnings)
app.use(`${API_PREFIX}/driver`, driver_routes_1.driverRouter);
// Broadcast routes (booking broadcasts for drivers)
app.use(`${API_PREFIX}/broadcasts`, broadcast_routes_1.broadcastRouter);
// Multi-vehicle Order System (NEW)
app.use(`${API_PREFIX}/orders`, order_routes_1.default);
// Transporter routes (availability, profile, stats)
app.use(`${API_PREFIX}/transporter`, transporter_routes_1.default);
// Notification routes (FCM token registration)
app.use(`${API_PREFIX}/notifications`, notification_routes_1.notificationRouter);
// =============================================================================
// DATABASE DEBUG ROUTES (Development only)
// =============================================================================
if (environment_1.config.isDevelopment) {
    // View all data (for debugging)
    app.get(`${API_PREFIX}/debug/database`, (_req, res) => {
        res.json({
            success: true,
            data: db_1.db.getRawData()
        });
    });
    // View stats
    app.get(`${API_PREFIX}/debug/stats`, (_req, res) => {
        res.json({
            success: true,
            data: db_1.db.getStats()
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
app.use(error_middleware_1.errorHandler);
// =============================================================================
// START SERVER
// =============================================================================
const PORT = environment_1.config.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
    const stats = db_1.db.getStats();
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
    console.log(`║   📍 Environment: ${environment_1.config.nodeEnv.padEnd(46)}║`);
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
    logger_service_1.logger.info(`Server started on port ${PORT}`);
});
// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger_service_1.logger.error('Uncaught exception', error);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger_service_1.logger.error('Unhandled rejection', reason);
});
// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================
const gracefulShutdown = (signal) => {
    logger_service_1.logger.info(`${signal} received. Starting graceful shutdown...`);
    server.close(() => {
        logger_service_1.logger.info('HTTP server closed');
        // Clear cache
        cache_middleware_1.cache.clear();
        logger_service_1.logger.info('Cache cleared');
        // Close database connections (if any)
        logger_service_1.logger.info('Graceful shutdown complete');
        process.exit(0);
    });
    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger_service_1.logger.error('Forced shutdown after timeout');
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
    const connectedUsers = [];
    const io = require('./shared/services/socket.service').getIO();
    if (io) {
        io.sockets.sockets.forEach((socket) => {
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
//# sourceMappingURL=server.js.map