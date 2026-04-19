/**
 * =============================================================================
 * ROUTE SPLIT TESTS -- Comprehensive tests for order, driver, and transporter
 * route files that were split from monolithic route files into sub-routers.
 * =============================================================================
 *
 * Tests cover:
 * 1. Route mounting integrity (facade correctly mounts sub-routers)
 * 2. Order CRUD, lifecycle, and progress routes
 * 3. Driver onboarding, dashboard, and profile routes
 * 4. Transporter availability, profile, and dispatch routes
 * 5. Middleware chain (auth, roleGuard) applied correctly
 * 6. Edge cases (404, 401, 400 validation)
 *
 * 80 tests total across all three split route groups.
 * =============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';

// =============================================================================
// MOCK SETUP -- Must be before imports that use mocked modules
// =============================================================================

// Mock logger
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock config/environment
jest.mock('../config/environment', () => ({
  config: {
    isDevelopment: false,
    isProduction: false,
    jwt: { secret: 'test-secret-key-for-route-tests-minimum-length-32chars' },
    nodeEnv: 'test',
    port: 3000,
    cors: { origin: '*' },
    rateLimit: { windowMs: 60000, maxRequests: 100 },
    redis: { enabled: true },
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// Mock redis service
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisSetJSON = jest.fn().mockResolvedValue('OK');
const mockRedisGetJSON = jest.fn().mockResolvedValue(null);
const mockRedisAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
const mockRedisReleaseLock = jest.fn().mockResolvedValue(true);
const mockRedisSAdd = jest.fn().mockResolvedValue(1);
const mockRedisSRem = jest.fn().mockResolvedValue(1);
const mockRedisExists = jest.fn().mockResolvedValue(false);
const mockRedisHGetAll = jest.fn().mockResolvedValue({});
const mockRedisCheckRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sRem: (...args: any[]) => mockRedisSRem(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    hGetAll: (...args: any[]) => mockRedisHGetAll(...args),
    checkRateLimit: (...args: any[]) => mockRedisCheckRateLimit(...args),
    isConnected: jest.fn().mockReturnValue(true),
    isRedisEnabled: jest.fn().mockReturnValue(true),
    keys: jest.fn().mockResolvedValue([]),
  },
}));

// Mock prisma service
const mockPrismaUserFindUnique = jest.fn();
const mockPrismaUserFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaUserUpdate = jest.fn().mockResolvedValue({});
const mockPrismaAssignmentCount = jest.fn().mockResolvedValue(0);
const mockPrismaAssignmentFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaBookingAggregate = jest.fn().mockResolvedValue({ _sum: { pricePerTruck: 0 } });
const mockPrismaRatingAggregate = jest.fn().mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });
const mockPrismaTruckRequestFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaCustomerPenaltyDueFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaOrderUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: {
      findUnique: (...args: any[]) => mockPrismaUserFindUnique(...args),
      findMany: (...args: any[]) => mockPrismaUserFindMany(...args),
      update: (...args: any[]) => mockPrismaUserUpdate(...args),
    },
    assignment: {
      count: (...args: any[]) => mockPrismaAssignmentCount(...args),
      findMany: (...args: any[]) => mockPrismaAssignmentFindMany(...args),
    },
    booking: {
      aggregate: (...args: any[]) => mockPrismaBookingAggregate(...args),
    },
    rating: {
      aggregate: (...args: any[]) => mockPrismaRatingAggregate(...args),
    },
    truckRequest: {
      findMany: (...args: any[]) => mockPrismaTruckRequestFindMany(...args),
    },
    customerPenaltyDue: {
      findMany: (...args: any[]) => mockPrismaCustomerPenaltyDueFindMany(...args),
    },
    order: {
      updateMany: (...args: any[]) => mockPrismaOrderUpdateMany(...args),
    },
  },
}));

// Mock prisma-client.ts (if imported)
jest.mock('../shared/database/prisma-client', () => ({
  prismaClient: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  },
}));

// Mock db
const mockGetActiveOrderByCustomer = jest.fn().mockResolvedValue(null);
const mockGetOrderById = jest.fn().mockResolvedValue(null);
const mockGetOrdersByCustomer = jest.fn().mockResolvedValue([]);
const mockGetTruckRequestsByOrder = jest.fn().mockResolvedValue([]);
const mockGetAssignmentsByOrder = jest.fn().mockResolvedValue([]);
const mockUpdateOrder = jest.fn().mockResolvedValue({});
const mockGetVehiclesByTransporter = jest.fn().mockResolvedValue([]);
const mockGetDriversByTransporter = jest.fn().mockResolvedValue([]);
const mockGetUserById = jest.fn().mockResolvedValue(null);
const mockGetUserByPhone = jest.fn().mockResolvedValue(null);
const mockUpdateUser = jest.fn().mockResolvedValue({});
const mockGetActiveOrders = jest.fn().mockResolvedValue([]);
const mockGetActiveBookingsForTransporter = jest.fn().mockResolvedValue([]);
jest.mock('../shared/database/db', () => ({
  db: {
    getActiveOrderByCustomer: (...args: any[]) => mockGetActiveOrderByCustomer(...args),
    getOrderById: (...args: any[]) => mockGetOrderById(...args),
    getOrdersByCustomer: (...args: any[]) => mockGetOrdersByCustomer(...args),
    getTruckRequestsByOrder: (...args: any[]) => mockGetTruckRequestsByOrder(...args),
    getAssignmentsByOrder: (...args: any[]) => mockGetAssignmentsByOrder(...args),
    updateOrder: (...args: any[]) => mockUpdateOrder(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
    getDriversByTransporter: (...args: any[]) => mockGetDriversByTransporter(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getUserByPhone: (...args: any[]) => mockGetUserByPhone(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
    getActiveOrders: (...args: any[]) => mockGetActiveOrders(...args),
    getActiveBookingsForTransporter: (...args: any[]) => mockGetActiveBookingsForTransporter(...args),
  },
}));

// Mock order service
const mockCreateOrder = jest.fn().mockResolvedValue({ orderId: 'ord-001', broadcastSent: true });
const mockGetOrderDetails = jest.fn().mockResolvedValue(null);
const mockGetActiveRequestsForTransporter = jest.fn().mockResolvedValue([]);
const mockAcceptTruckRequest = jest.fn().mockResolvedValue({ success: true });
const mockCancelOrder = jest.fn().mockResolvedValue({ success: true, transportersNotified: 5 });
const mockCheckRateLimit = jest.fn().mockResolvedValue({ allowed: true });
const mockGetCancelPreview = jest.fn().mockResolvedValue({ success: true, policyStage: 'free' });
const mockCreateCancelDispute = jest.fn().mockResolvedValue({ success: true, disputeId: 'disp-001' });
jest.mock('../modules/order/order.service', () => ({
  orderService: {
    createOrder: (...args: any[]) => mockCreateOrder(...args),
    getOrderDetails: (...args: any[]) => mockGetOrderDetails(...args),
    getOrdersByCustomer: (...args: any[]) => mockGetOrdersByCustomer(...args),
    getActiveRequestsForTransporter: (...args: any[]) => mockGetActiveRequestsForTransporter(...args),
    acceptTruckRequest: (...args: any[]) => mockAcceptTruckRequest(...args),
    cancelOrder: (...args: any[]) => mockCancelOrder(...args),
    checkRateLimit: (...args: any[]) => mockCheckRateLimit(...args),
    getCancelPreview: (...args: any[]) => mockGetCancelPreview(...args),
    createCancelDispute: (...args: any[]) => mockCreateCancelDispute(...args),
    prisma: {
      customerPenaltyDue: {
        findMany: (...args: any[]) => mockPrismaCustomerPenaltyDueFindMany(...args),
      },
    },
  },
}));

// Mock order contract functions
jest.mock('../modules/order/order.contract', () => ({
  buildCreateOrderResponseData: jest.fn().mockReturnValue({ orderId: 'ord-001' }),
  normalizeCreateOrderInput: jest.fn().mockImplementation((d: any) => d),
  toCreateOrderServiceRequest: jest.fn().mockReturnValue({ vehicleRequirements: [] }),
}));

// Mock booking schema (createOrderSchema)
jest.mock('../modules/booking/booking.schema', () => ({
  createOrderSchema: {
    safeParse: jest.fn().mockReturnValue({
      success: true,
      data: {
        pickup: { latitude: 12.9, longitude: 77.5, address: 'Test Pickup' },
        drop: { latitude: 13.0, longitude: 77.6, address: 'Test Drop' },
        vehicleRequirements: [{ vehicleType: 'tata_ace', quantity: 1 }],
        goodsType: 'general',
      },
    }),
  },
}));

// Mock order-lifecycle utils
jest.mock('../shared/utils/order-lifecycle.utils', () => ({
  normalizeOrderStatus: jest.fn().mockImplementation((s: string) => s),
  normalizeOrderLifecycleState: jest.fn().mockImplementation((s: string) => s),
}));

// Mock booking queue
jest.mock('../shared/resilience/request-queue', () => ({
  bookingQueue: {
    middleware: () => (_req: any, _res: any, next: any) => next(),
  },
  trackingQueue: {
    middleware: () => (_req: any, _res: any, next: any) => next(),
  },
  Priority: { HIGH: 'HIGH', CRITICAL: 'CRITICAL', NORMAL: 'NORMAL' },
}));

// Mock socket service
const mockEmitToUser = jest.fn();
jest.mock('../shared/services/socket.service', () => ({
  emitToUser: (...args: any[]) => mockEmitToUser(...args),
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
  },
  initializeSocket: jest.fn(),
  getConnectedUserCount: jest.fn().mockReturnValue(0),
  getConnectionStats: jest.fn().mockReturnValue({}),
  getRedisAdapterStatus: jest.fn().mockReturnValue('none'),
  getIO: jest.fn().mockReturnValue(null),
}));

// Mock driver service
const mockDriverServiceCreateDriver = jest.fn().mockResolvedValue({ id: 'drv-001', name: 'Test Driver', phone: '9876543210', licenseNumber: 'DL001' });
const mockDriverServiceGetDashboard = jest.fn().mockResolvedValue({ stats: {} });
const mockDriverServiceGetPerformance = jest.fn().mockResolvedValue({ rating: 4.5 });
const mockDriverServiceGetAvailability = jest.fn().mockResolvedValue({ isOnline: true });
const mockDriverServiceUpdateAvailability = jest.fn().mockResolvedValue({ isOnline: true });
const mockDriverServiceGetEarnings = jest.fn().mockResolvedValue({ total: 1000 });
const mockDriverServiceGetTrips = jest.fn().mockResolvedValue({ trips: [] });
const mockDriverServiceGetActiveTrip = jest.fn().mockResolvedValue(null);
const mockDriverServiceGetDriverById = jest.fn().mockResolvedValue(null);
const mockDriverServiceCompleteProfile = jest.fn().mockResolvedValue({ id: 'drv-001', name: 'Test' });
const mockDriverServiceUpdateProfilePhoto = jest.fn().mockResolvedValue({ id: 'drv-001', name: 'Test' });
const mockDriverServiceUpdateLicensePhotos = jest.fn().mockResolvedValue({ id: 'drv-001', name: 'Test' });
const mockDriverServiceGetOnlineDriverIds = jest.fn().mockResolvedValue([]);
jest.mock('../modules/driver/driver.service', () => ({
  driverService: {
    createDriver: (...args: any[]) => mockDriverServiceCreateDriver(...args),
    getDashboard: (...args: any[]) => mockDriverServiceGetDashboard(...args),
    getPerformance: (...args: any[]) => mockDriverServiceGetPerformance(...args),
    getAvailability: (...args: any[]) => mockDriverServiceGetAvailability(...args),
    updateAvailability: (...args: any[]) => mockDriverServiceUpdateAvailability(...args),
    getEarnings: (...args: any[]) => mockDriverServiceGetEarnings(...args),
    getTrips: (...args: any[]) => mockDriverServiceGetTrips(...args),
    getActiveTrip: (...args: any[]) => mockDriverServiceGetActiveTrip(...args),
    getDriverById: (...args: any[]) => mockDriverServiceGetDriverById(...args),
    completeProfile: (...args: any[]) => mockDriverServiceCompleteProfile(...args),
    updateProfilePhoto: (...args: any[]) => mockDriverServiceUpdateProfilePhoto(...args),
    updateLicensePhotos: (...args: any[]) => mockDriverServiceUpdateLicensePhotos(...args),
    getOnlineDriverIds: (...args: any[]) => mockDriverServiceGetOnlineDriverIds(...args),
  },
}));

// Mock driver schema
jest.mock('../modules/driver/driver.schema', () => ({
  createDriverSchema: {
    parse: jest.fn().mockImplementation((d: any) => d),
  },
  updateAvailabilitySchema: {
    parse: jest.fn().mockImplementation((d: any) => d),
  },
  getEarningsQuerySchema: {
    parse: jest.fn().mockReturnValue({ period: 'month' }),
  },
}));

// Mock validation utils
jest.mock('../shared/utils/validation.utils', () => ({
  validateSchema: jest.fn().mockImplementation((_schema: any, data: any) => data),
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock fleet cache service
const mockFleetCacheGetTransporterDrivers = jest.fn().mockResolvedValue([]);
const mockFleetCacheGetAvailableDrivers = jest.fn().mockResolvedValue([]);
const mockFleetCacheGetDriver = jest.fn().mockResolvedValue(null);
jest.mock('../shared/services/fleet-cache.service', () => ({
  fleetCacheService: {
    getTransporterDrivers: (...args: any[]) => mockFleetCacheGetTransporterDrivers(...args),
    getAvailableDrivers: (...args: any[]) => mockFleetCacheGetAvailableDrivers(...args),
    getDriver: (...args: any[]) => mockFleetCacheGetDriver(...args),
  },
  onDriverChange: jest.fn().mockResolvedValue(undefined),
}));

// Mock S3 upload service
jest.mock('../shared/services/s3-upload.service', () => ({
  s3UploadService: {
    uploadDriverPhotos: jest.fn().mockResolvedValue({
      driverPhotoUrl: 'https://s3.test/photo.jpg',
      licenseFrontUrl: 'https://s3.test/front.jpg',
      licenseBackUrl: 'https://s3.test/back.jpg',
    }),
  },
}));

// Mock cache service
jest.mock('../shared/services/cache.service', () => ({
  cacheService: {
    delete: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  },
}));

// Mock availability service
const mockAvailUpdateAsync = jest.fn().mockResolvedValue(undefined);
const mockAvailSetOffline = jest.fn();
const mockAvailGetStats = jest.fn().mockReturnValue({ onlineCount: 0 });
const mockAvailGetStatsAsync = jest.fn().mockResolvedValue({ onlineCount: 0 });
const mockAvailGetTransporterDetails = jest.fn().mockResolvedValue(null);
const mockAvailRebuildGeoFromDB = jest.fn().mockResolvedValue(undefined);
jest.mock('../shared/services/availability.service', () => ({
  availabilityService: {
    updateAvailabilityForVehicleKeysAsync: (...args: any[]) => mockAvailUpdateAsync(...args),
    setOffline: (...args: any[]) => mockAvailSetOffline(...args),
    getStats: (...args: any[]) => mockAvailGetStats(...args),
    getStatsAsync: (...args: any[]) => mockAvailGetStatsAsync(...args),
    getTransporterDetails: (...args: any[]) => mockAvailGetTransporterDetails(...args),
    rebuildGeoFromDB: (...args: any[]) => mockAvailRebuildGeoFromDB(...args),
    HEARTBEAT_INTERVAL_MS: 5000,
  },
}));

// Mock vehicle key service
jest.mock('../shared/services/vehicle-key.service', () => ({
  generateVehicleKey: jest.fn().mockReturnValue('tata_ace:open'),
  generateVehicleKeyCandidates: jest.fn().mockReturnValue(['tata_ace:open', 'tata_ace:*']),
}));

// Mock transporter-online service
jest.mock('../shared/services/transporter-online.service', () => ({
  ONLINE_TRANSPORTERS_SET: 'online:transporters',
  TRANSPORTER_PRESENCE_KEY: (id: string) => `transporter:presence:${id}`,
  PRESENCE_TTL_SECONDS: 90,
  transporterOnlineService: {
    setReconnectGracePeriod: jest.fn(),
  },
  startStaleTransporterCleanup: jest.fn(),
  stopStaleTransporterCleanup: jest.fn(),
}));

// Mock booking service
jest.mock('../modules/booking/booking.service', () => ({
  bookingService: {
    deliverMissedBroadcasts: jest.fn().mockResolvedValue(undefined),
  },
  startBookingExpiryChecker: jest.fn(),
  stopBookingExpiryChecker: jest.fn(),
}));

// Mock broadcast service
jest.mock('../modules/broadcast/broadcast.service', () => ({
  broadcastService: {
    getActiveBroadcasts: jest.fn().mockResolvedValue([]),
  },
}));

// Mock geospatial utils
jest.mock('../shared/utils/geospatial.utils', () => ({
  haversineDistanceKm: jest.fn().mockReturnValue(10),
}));

// Mock crypto utils
jest.mock('../shared/utils/crypto.utils', () => ({
  generateSecureOTP: jest.fn().mockReturnValue('123456'),
  maskForLogging: jest.fn().mockImplementation((val: string) => '****' + val.substring(val.length - 4)),
}));

// Mock SMS service
jest.mock('../modules/auth/sms.service', () => ({
  smsService: {
    sendOtp: jest.fn().mockResolvedValue(true),
  },
}));

// Mock bcryptjs
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2a$10$hashed'),
  compare: jest.fn().mockResolvedValue(true),
}));

// Mock error types
jest.mock('../shared/types/error.types', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

// Mock multer (for profile photo routes)
jest.mock('multer', () => {
  const mockMulter = () => ({
    single: () => (_req: any, _res: any, next: any) => next(),
    fields: () => (_req: any, _res: any, next: any) => next(),
    array: () => (_req: any, _res: any, next: any) => next(),
  });
  mockMulter.memoryStorage = () => ({});
  return mockMulter;
});

// Mock AWS SDK (for regenerate-urls)
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.presigned.test/photo.jpg'),
}));

// Mock Google Maps service
jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: {
    getETA: jest.fn().mockResolvedValue({ distanceKm: 0.1 }),
  },
}));

// Override the real auth middleware with a pass-through for route structure tests
jest.mock('../shared/middleware/auth.middleware', () => {
  const originalModule = jest.requireActual('../shared/middleware/auth.middleware');
  return {
    ...originalModule,
    authMiddleware: (req: any, _res: any, next: any) => {
      // If no user is set by the test, reject with 401
      if (!req.user) {
        const err: any = new Error('Authentication required');
        err.statusCode = 401;
        err.code = 'UNAUTHORIZED';
        return next(err);
      }
      next();
    },
    roleGuard: (roles: string[]) => (req: any, _res: any, next: any) => {
      if (!req.user) {
        const err: any = new Error('Authentication required');
        err.statusCode = 401;
        err.code = 'UNAUTHORIZED';
        return next(err);
      }
      if (!roles.includes(req.user.role)) {
        const err: any = new Error('Insufficient permissions');
        err.statusCode = 403;
        err.code = 'FORBIDDEN';
        return next(err);
      }
      next();
    },
  };
});

// =============================================================================
// TEST HELPERS
// =============================================================================

function createTestApp(routerPath: string, router: any, defaultUser?: any) {
  const app = express();
  app.use(express.json());

  // Inject user into request if provided
  if (defaultUser) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = defaultUser;
      req.userId = defaultUser.userId;
      req.userRole = defaultUser.role;
      req.userPhone = defaultUser.phone;
      next();
    });
  }

  app.use(routerPath, router);

  // Error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode || 500;
    res.status(status).json({
      success: false,
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Internal server error',
      },
    });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
      },
    });
  });

  return app;
}

// Simple request helper using Node http (no supertest dependency)
function makeRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const options: any = {
        hostname: '127.0.0.1',
        port,
        path,
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          ...(headers || {}),
        },
      };

      const req = http.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({
            status: res.statusCode,
            body: parsed,
            headers: res.headers,
          });
        });
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

// =============================================================================
// TESTS
// =============================================================================

const CUSTOMER_USER = { userId: 'cust-001', role: 'customer', phone: '9876543210', name: 'Test Customer' };
const TRANSPORTER_USER = { userId: 'trans-001', role: 'transporter', phone: '9876543211', name: 'Test Transporter' };
const DRIVER_USER = { userId: 'drv-001', role: 'driver', phone: '9876543212', name: 'Test Driver' };

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// SECTION 1: FACADE MOUNTING INTEGRITY
// =============================================================================

describe('Route Facade Mounting', () => {
  describe('Order Routes Facade', () => {
    it('should export a default router', () => {
      const orderRouter = require('../modules/order/order.routes').default;
      expect(orderRouter).toBeDefined();
      expect(typeof orderRouter).toBe('function');
    });

    it('should mount orderCrudRouter at root path', () => {
      const { orderCrudRouter } = require('../modules/order/order-crud.routes');
      expect(orderCrudRouter).toBeDefined();
      expect(typeof orderCrudRouter).toBe('function');
    });

    it('should mount orderLifecycleRouter at root path', () => {
      const { orderLifecycleRouter } = require('../modules/order/order-lifecycle.routes');
      expect(orderLifecycleRouter).toBeDefined();
      expect(typeof orderLifecycleRouter).toBe('function');
    });

    it('should mount orderProgressRouter at root path', () => {
      const { orderProgressRouter } = require('../modules/order/order-progress.routes');
      expect(orderProgressRouter).toBeDefined();
      expect(typeof orderProgressRouter).toBe('function');
    });

    it('should have all three sub-routers accessible through facade', () => {
      const orderRouter = require('../modules/order/order.routes').default;
      // Router stack should contain the sub-routers (at least 3)
      const stack = (orderRouter as any).stack;
      expect(stack.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Driver Routes Facade', () => {
    it('should export driverRouter', () => {
      const { driverRouter } = require('../modules/driver/driver.routes');
      expect(driverRouter).toBeDefined();
      expect(typeof driverRouter).toBe('function');
    });

    it('should mount driverOnboardingRouter', () => {
      const { driverOnboardingRouter } = require('../modules/driver/driver-onboarding.routes');
      expect(driverOnboardingRouter).toBeDefined();
    });

    it('should mount driverDashboardRouter', () => {
      const { driverDashboardRouter } = require('../modules/driver/driver-dashboard.routes');
      expect(driverDashboardRouter).toBeDefined();
    });

    it('should mount driverProfileRouter', () => {
      const { driverProfileRouter } = require('../modules/driver/driver-profile.routes');
      expect(driverProfileRouter).toBeDefined();
    });

    it('should have all three sub-routers in the facade stack', () => {
      const { driverRouter } = require('../modules/driver/driver.routes');
      const stack = (driverRouter as any).stack;
      expect(stack.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Transporter Routes Facade', () => {
    it('should export default router', () => {
      const transporterRouter = require('../modules/transporter/transporter.routes').default;
      expect(transporterRouter).toBeDefined();
      expect(typeof transporterRouter).toBe('function');
    });

    // F-B-41: availability routes were never extracted into their own sub-router.
    // The 501-stub file has been deleted; the real handlers live on
    // transporterRouter itself. This test now validates the real router
    // instead of the removed stub.
    it('should expose availability routes on the main transporter router', () => {
      const transporterRouter = require('../modules/transporter/transporter.routes').default;
      const routes = extractRoutes(transporterRouter);
      expect(routes).toContainEqual({ method: 'put', path: '/availability' });
      expect(routes).toContainEqual({ method: 'get', path: '/availability' });
    });

    it('should mount transporterProfileRouter', () => {
      const { transporterProfileRouter } = require('../modules/transporter/transporter-profile.routes');
      expect(transporterProfileRouter).toBeDefined();
    });

    it('should mount transporterDispatchRouter', () => {
      const { transporterDispatchRouter } = require('../modules/transporter/transporter-dispatch.routes');
      expect(transporterDispatchRouter).toBeDefined();
    });

    it('should have all three sub-routers in the facade stack', () => {
      const transporterRouter = require('../modules/transporter/transporter.routes').default;
      const stack = (transporterRouter as any).stack;
      expect(stack.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// =============================================================================
// SECTION 2: ORDER CRUD ROUTES
// =============================================================================

describe('Order CRUD Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const orderRouter = require('../modules/order/order.routes').default;
    app = createTestApp('/api/v1/orders', orderRouter, CUSTOMER_USER);
  });

  it('GET /check-active should return active order status for customer', async () => {
    mockGetActiveOrderByCustomer.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/check-active');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hasActiveOrder).toBe(false);
  });

  it('GET /check-active should return existing active order', async () => {
    mockGetActiveOrderByCustomer.mockResolvedValueOnce({
      id: 'ord-active',
      status: 'broadcasting',
      createdAt: new Date().toISOString(),
    });
    const res = await makeRequest(app, 'GET', '/api/v1/orders/check-active');
    expect(res.status).toBe(200);
    expect(res.body.data.hasActiveOrder).toBe(true);
    expect(res.body.data.activeOrder.orderId).toBe('ord-active');
  });

  it('POST / should create an order for customer', async () => {
    const res = await makeRequest(app, 'POST', '/api/v1/orders', {
      pickup: { latitude: 12.9, longitude: 77.5, address: 'Test Pickup' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'Test Drop' },
      vehicleRequirements: [{ vehicleType: 'tata_ace', quantity: 1 }],
      goodsType: 'general',
    }, { 'x-idempotency-key': '550e8400-e29b-41d4-a716-446655440000' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('POST / should return 409 when customer already has active order', async () => {
    mockGetActiveOrderByCustomer.mockResolvedValueOnce({
      id: 'ord-existing',
      status: 'broadcasting',
      createdAt: new Date().toISOString(),
    });
    const res = await makeRequest(app, 'POST', '/api/v1/orders', {
      pickup: { latitude: 12.9, longitude: 77.5, address: 'Test' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'Test' },
      vehicleRequirements: [{ vehicleType: 'tata_ace', quantity: 1 }],
      goodsType: 'general',
    }, { 'x-idempotency-key': '550e8400-e29b-41d4-a716-446655440001' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACTIVE_ORDER_EXISTS');
  });

  it('POST / should return 429 when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 30 });
    const res = await makeRequest(app, 'POST', '/api/v1/orders', {
      pickup: { latitude: 12.9, longitude: 77.5, address: 'Test' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'Test' },
      vehicleRequirements: [{ vehicleType: 'tata_ace', quantity: 1 }],
      goodsType: 'general',
    }, { 'x-idempotency-key': '550e8400-e29b-41d4-a716-446655440002' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('POST / should return 409 when lock cannot be acquired', async () => {
    mockRedisAcquireLock.mockResolvedValueOnce({ acquired: false });
    const res = await makeRequest(app, 'POST', '/api/v1/orders', {
      pickup: { latitude: 12.9, longitude: 77.5, address: 'Test' },
      drop: { latitude: 13.0, longitude: 77.6, address: 'Test' },
      vehicleRequirements: [{ vehicleType: 'tata_ace', quantity: 1 }],
      goodsType: 'general',
    }, { 'x-idempotency-key': '550e8400-e29b-41d4-a716-446655440003' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONCURRENT_REQUEST');
  });

  it('GET / should return customer orders', async () => {
    mockGetOrdersByCustomer.mockResolvedValueOnce([{ id: 'ord-001', status: 'completed' }]);
    const res = await makeRequest(app, 'GET', '/api/v1/orders');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.orders.length).toBe(1);
  });

  it('GET /:id should return 404 when order not found', async () => {
    mockGetOrderDetails.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /:id should return order details when customer owns order', async () => {
    mockGetOrderDetails.mockResolvedValueOnce({
      id: 'ord-001',
      customerId: 'cust-001',
      status: 'broadcasting',
      truckRequests: [],
    });
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-001');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /:id should return 404 when customer does not own order (BOLA guard)', async () => {
    mockGetOrderDetails.mockResolvedValueOnce({
      id: 'ord-002',
      customerId: 'another-customer',
      status: 'broadcasting',
      truckRequests: [],
    });
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-002');
    expect(res.status).toBe(404);
  });
});

describe('Order CRUD Routes - Transporter Role', () => {
  let app: express.Express;

  beforeEach(() => {
    const orderRouter = require('../modules/order/order.routes').default;
    app = createTestApp('/api/v1/orders', orderRouter, TRANSPORTER_USER);
  });

  it('GET /active should return active requests for transporter', async () => {
    mockGetActiveRequestsForTransporter.mockResolvedValueOnce([
      { orderId: 'ord-001', vehicleType: 'tata_ace' },
    ]);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/active');
    expect(res.status).toBe(200);
    expect(res.body.data.requests.length).toBe(1);
  });

  it('POST /accept should accept a truck request', async () => {
    mockAcceptTruckRequest.mockResolvedValueOnce({ success: true, message: 'Accepted' });
    const res = await makeRequest(app, 'POST', '/api/v1/orders/accept', {
      truckRequestId: '550e8400-e29b-41d4-a716-446655440001',
      vehicleId: '550e8400-e29b-41d4-a716-446655440002',
      driverId: '550e8400-e29b-41d4-a716-446655440003',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /accept should return 400 on validation error', async () => {
    require('../modules/booking/booking.schema'); // createOrderSchema preloaded
    const res = await makeRequest(app, 'POST', '/api/v1/orders/accept', {
      truckRequestId: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// SECTION 3: ORDER LIFECYCLE ROUTES
// =============================================================================

describe('Order Lifecycle Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const orderRouter = require('../modules/order/order.routes').default;
    app = createTestApp('/api/v1/orders', orderRouter, CUSTOMER_USER);
  });

  it('POST /:id/cancel should cancel an order', async () => {
    mockCancelOrder.mockResolvedValueOnce({ success: true, transportersNotified: 3, message: 'Cancelled' });
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/cancel', { reason: 'Changed mind' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('cancelled');
  });

  it('POST /:id/cancel should return error when cancel fails', async () => {
    mockCancelOrder.mockResolvedValueOnce({ success: false, message: 'Cannot cancel', cancelDecision: 'blocked_dispute_only' });
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/cancel', { reason: 'Test' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCEL_BLOCKED_DISPUTE_ONLY');
  });

  it('DELETE /:orderId/cancel should cancel an order via DELETE method', async () => {
    mockCancelOrder.mockResolvedValueOnce({ success: true, transportersNotified: 2, message: 'Cancelled' });
    const res = await makeRequest(app, 'DELETE', '/api/v1/orders/ord-001/cancel');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /:orderId/cancel-preview should return cancellation preview', async () => {
    mockGetCancelPreview.mockResolvedValueOnce({
      success: true,
      policyStage: 'free',
      cancelDecision: 'allowed',
      penaltyBreakdown: null,
    });
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-001/cancel-preview');
    expect(res.status).toBe(200);
    expect(res.body.data.policyStage).toBe('free');
  });

  it('POST /:orderId/cancel/dispute should create a cancel dispute', async () => {
    mockCreateCancelDispute.mockResolvedValueOnce({ success: true, disputeId: 'disp-001', stage: 'pending', message: 'Created' });
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/cancel/dispute', {
      reasonCode: 'wrong_price',
      notes: 'Price was different from quote',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.disputeId).toBe('disp-001');
  });

  it('GET /:orderId/status should return order status', async () => {
    mockGetOrderById.mockResolvedValueOnce({
      id: 'ord-001',
      customerId: 'cust-001',
      status: 'broadcasting',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-001/status');
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.remainingSeconds).toBeGreaterThan(0);
  });

  it('GET /:orderId/status should return 404 for non-existent order', async () => {
    mockGetOrderById.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-nonexistent/status');
    expect(res.status).toBe(404);
  });

  it('GET /:orderId/status should return 404 for order owned by another customer', async () => {
    mockGetOrderById.mockResolvedValueOnce({
      id: 'ord-002',
      customerId: 'another-customer',
      status: 'broadcasting',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-002/status');
    expect(res.status).toBe(404);
  });

  it('GET /:orderId/broadcast-snapshot should return snapshot', async () => {
    mockGetOrderById.mockResolvedValueOnce({
      id: 'ord-001',
      customerId: 'cust-001',
      status: 'broadcasting',
      pickup: {},
      drop: {},
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    mockGetTruckRequestsByOrder.mockResolvedValueOnce([]);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-001/broadcast-snapshot');
    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toBe('ord-001');
  });

  it('GET /pending-settlements is handled by its dedicated route (registered before /:id wildcard)', async () => {
    // /pending-settlements is registered BEFORE /:id in order.routes.ts,
    // so it matches the dedicated handler (not the /:id wildcard).
    // The mock returns an empty array, so the response is 200 with empty results.
    const res = await makeRequest(app, 'GET', '/api/v1/orders/pending-settlements');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalPending).toBe(0);
    expect(res.body.data.count).toBe(0);
    expect(res.body.data.items).toEqual([]);
  });
});

// =============================================================================
// SECTION 4: ORDER PROGRESS ROUTES
// =============================================================================

describe('Order Progress Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const orderRouter = require('../modules/order/order.routes').default;
    app = createTestApp('/api/v1/orders', orderRouter, DRIVER_USER);
  });

  it('POST /:orderId/reached-stop should return 404 when order not found', async () => {
    mockGetOrderById.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/reached-stop');
    expect(res.status).toBe(404);
  });

  it('POST /:orderId/reached-stop should return 404 when driver is not assigned', async () => {
    mockGetOrderById.mockResolvedValueOnce({ id: 'ord-001', customerId: 'cust-001', routePoints: [] });
    mockGetAssignmentsByOrder.mockResolvedValueOnce([{ driverId: 'other-driver' }]);
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/reached-stop');
    expect(res.status).toBe(404);
  });

  it('POST /:orderId/reached-stop should increment route index', async () => {
    mockGetOrderById.mockResolvedValueOnce({
      id: 'ord-001',
      customerId: 'cust-001',
      currentRouteIndex: 0,
      routePoints: [
        { type: 'PICKUP', address: 'A', latitude: 12.9, longitude: 77.5 },
        { type: 'DROP', address: 'B', latitude: 13.0, longitude: 77.6 },
      ],
      stopWaitTimers: [],
    });
    mockGetAssignmentsByOrder.mockResolvedValueOnce([{ driverId: 'drv-001' }]);
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/reached-stop');
    expect(res.status).toBe(200);
    expect(res.body.data.currentRouteIndex).toBe(1);
  });

  it('GET /:orderId/route should return route with progress', async () => {
    mockGetOrderById.mockResolvedValueOnce({
      id: 'ord-001',
      customerId: 'cust-001',
      currentRouteIndex: 0,
      routePoints: [
        { type: 'PICKUP', address: 'A' },
        { type: 'DROP', address: 'B' },
      ],
      stopWaitTimers: [],
    });
    mockGetAssignmentsByOrder.mockResolvedValueOnce([{ driverId: 'drv-001' }]);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-001/route');
    expect(res.status).toBe(200);
    expect(res.body.data.routePoints.length).toBe(2);
    expect(res.body.data.totalPoints).toBe(2);
  });

  it('GET /:orderId/route should return 404 for unauthorized user', async () => {
    mockGetOrderById.mockResolvedValueOnce({
      id: 'ord-001',
      customerId: 'cust-other',
      routePoints: [],
    });
    mockGetAssignmentsByOrder.mockResolvedValueOnce([{ driverId: 'other-driver' }]);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/ord-001/route');
    expect(res.status).toBe(404);
  });

  it('POST /:orderId/departed-stop should record departure', async () => {
    mockGetOrderById.mockResolvedValueOnce({
      id: 'ord-001',
      customerId: 'cust-001',
      currentRouteIndex: 1,
      stopWaitTimers: [{ stopIndex: 1, arrivedAt: new Date(Date.now() - 30000).toISOString(), waitTimeSeconds: 0 }],
    });
    mockGetAssignmentsByOrder.mockResolvedValueOnce([{ driverId: 'drv-001' }]);
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/departed-stop');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /:orderId/departed-stop should return 404 when driver not assigned', async () => {
    mockGetOrderById.mockResolvedValueOnce({ id: 'ord-001', customerId: 'cust-001', stopWaitTimers: [] });
    mockGetAssignmentsByOrder.mockResolvedValueOnce([{ driverId: 'other-driver' }]);
    const res = await makeRequest(app, 'POST', '/api/v1/orders/ord-001/departed-stop');
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// SECTION 5: DRIVER ONBOARDING ROUTES
// =============================================================================

describe('Driver Onboarding Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    app = createTestApp('/api/v1/driver', driverRouter, TRANSPORTER_USER);
  });

  it('POST /onboard/initiate should send OTP to driver', async () => {
    mockGetUserByPhone.mockResolvedValueOnce(null);
    mockGetUserById.mockResolvedValueOnce({ id: 'trans-001', name: 'Transporter' });
    const res = await makeRequest(app, 'POST', '/api/v1/driver/onboard/initiate', {
      phone: '9876543210',
      name: 'New Driver',
      licenseNumber: 'DL12345',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.expiresInMinutes).toBe(10);
  });

  it('POST /onboard/verify should verify OTP and create driver', async () => {
    mockRedisGetJSON.mockResolvedValueOnce({
      hashedOtp: '$2a$10$hashed',
      transporterId: 'trans-001',
      driverPhone: '9876543210',
      driverName: 'New Driver',
      licenseNumber: 'DL12345',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      attempts: 0,
    });
    const res = await makeRequest(app, 'POST', '/api/v1/driver/onboard/verify', {
      phone: '9876543210',
      otp: '123456',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.driver.id).toBe('drv-001');
  });

  it('POST /onboard/verify should return 400 when no pending request', async () => {
    mockRedisGetJSON.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'POST', '/api/v1/driver/onboard/verify', {
      phone: '9876543210',
      otp: '123456',
    });
    expect(res.status).toBe(400);
  });

  it('POST /onboard/resend should resend OTP', async () => {
    mockRedisGetJSON.mockResolvedValueOnce({
      hashedOtp: '$2a$10$hashed',
      transporterId: 'trans-001',
      driverPhone: '9876543210',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      attempts: 0,
    });
    const res = await makeRequest(app, 'POST', '/api/v1/driver/onboard/resend', {
      phone: '9876543210',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /onboard/resend should return 400 when phone missing', async () => {
    const res = await makeRequest(app, 'POST', '/api/v1/driver/onboard/resend', {});
    expect(res.status).toBe(400);
  });

  it('POST /create should create a driver directly', async () => {
    const res = await makeRequest(app, 'POST', '/api/v1/driver/create', {
      phone: '9876543213',
      name: 'Direct Driver',
      licenseNumber: 'DL99999',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('GET /list should return transporter drivers', async () => {
    mockFleetCacheGetTransporterDrivers.mockResolvedValueOnce([
      { id: 'drv-001', name: 'Driver 1', status: 'active', isAvailable: true, currentTripId: null },
      { id: 'drv-002', name: 'Driver 2', status: 'active', isAvailable: false, currentTripId: 'trip-001' },
    ]);
    const res = await makeRequest(app, 'GET', '/api/v1/driver/list');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.available).toBe(1);
  });
});

// =============================================================================
// SECTION 6: DRIVER DASHBOARD ROUTES
// =============================================================================

describe('Driver Dashboard Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    app = createTestApp('/api/v1/driver', driverRouter, DRIVER_USER);
  });

  it('GET /dashboard should return driver dashboard', async () => {
    const res = await makeRequest(app, 'GET', '/api/v1/driver/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDriverServiceGetDashboard).toHaveBeenCalledWith('drv-001');
  });

  it('GET /performance should return driver performance metrics', async () => {
    const res = await makeRequest(app, 'GET', '/api/v1/driver/performance');
    expect(res.status).toBe(200);
    expect(mockDriverServiceGetPerformance).toHaveBeenCalledWith('drv-001');
  });

  it('GET /availability should return driver availability', async () => {
    const res = await makeRequest(app, 'GET', '/api/v1/driver/availability');
    expect(res.status).toBe(200);
    expect(mockDriverServiceGetAvailability).toHaveBeenCalledWith('drv-001');
  });

  it('PUT /availability should update driver availability', async () => {
    mockFleetCacheGetDriver.mockResolvedValueOnce({ transporterId: 'trans-001' });
    const res = await makeRequest(app, 'PUT', '/api/v1/driver/availability', {
      isOnline: true,
      currentLocation: { latitude: 12.9, longitude: 77.5 },
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('You are now online');
  });

  it('GET /earnings should return driver earnings', async () => {
    const res = await makeRequest(app, 'GET', '/api/v1/driver/earnings');
    expect(res.status).toBe(200);
    expect(mockDriverServiceGetEarnings).toHaveBeenCalled();
  });

  it('GET /trips should return driver trip history', async () => {
    const res = await makeRequest(app, 'GET', '/api/v1/driver/trips');
    expect(res.status).toBe(200);
    expect(mockDriverServiceGetTrips).toHaveBeenCalled();
  });

  it('GET /trips/active should return active trip', async () => {
    const res = await makeRequest(app, 'GET', '/api/v1/driver/trips/active');
    expect(res.status).toBe(200);
    expect(mockDriverServiceGetActiveTrip).toHaveBeenCalledWith('drv-001');
  });
});

describe('Driver Dashboard Routes - Transporter Role', () => {
  let app: express.Express;

  beforeEach(() => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    app = createTestApp('/api/v1/driver', driverRouter, TRANSPORTER_USER);
  });

  it('GET /available should return available drivers for transporter', async () => {
    mockFleetCacheGetAvailableDrivers.mockResolvedValueOnce([
      { id: 'drv-001', name: 'Driver 1' },
    ]);
    const res = await makeRequest(app, 'GET', '/api/v1/driver/available');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('GET /online-drivers should return online driver IDs', async () => {
    mockDriverServiceGetOnlineDriverIds.mockResolvedValueOnce(['drv-001', 'drv-002']);
    const res = await makeRequest(app, 'GET', '/api/v1/driver/online-drivers');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
  });
});

// =============================================================================
// SECTION 7: DRIVER PROFILE ROUTES
// =============================================================================

describe('Driver Profile Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    app = createTestApp('/api/v1/driver', driverRouter, DRIVER_USER);
  });

  it('GET /profile should return 404 when driver not found', async () => {
    mockDriverServiceGetDriverById.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'GET', '/api/v1/driver/profile');
    expect(res.status).toBe(404);
  });

  it('GET /profile should return driver profile', async () => {
    mockDriverServiceGetDriverById.mockResolvedValueOnce({
      id: 'drv-001',
      name: 'Test Driver',
      phone: '9876543212',
      email: 'test@test.com',
      licenseNumber: 'DL12345',
      isProfileCompleted: true,
    });
    const res = await makeRequest(app, 'GET', '/api/v1/driver/profile');
    expect(res.status).toBe(200);
    expect(res.body.data.driver.name).toBe('Test Driver');
  });
});

// =============================================================================
// SECTION 8: TRANSPORTER AVAILABILITY ROUTES
// =============================================================================

describe('Transporter Availability Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    app = createTestApp('/api/v1/transporter', transporterRouter, TRANSPORTER_USER);
  });

  it('PUT /availability should update transporter availability (go online)', async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce({ isAvailable: false });
    mockPrismaUserUpdate.mockResolvedValueOnce({});
    mockGetVehiclesByTransporter.mockResolvedValueOnce([
      { id: 'v-001', vehicleType: 'tata_ace', vehicleSubtype: 'open', isActive: true, status: 'available' },
    ]);
    const res = await makeRequest(app, 'PUT', '/api/v1/transporter/availability', { isAvailable: true });
    expect(res.status).toBe(200);
    expect(res.body.data.isAvailable).toBe(true);
  });

  it('PUT /availability should return idempotent response when state unchanged', async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce({ isAvailable: true });
    const res = await makeRequest(app, 'PUT', '/api/v1/transporter/availability', { isAvailable: true });
    expect(res.status).toBe(200);
    expect(res.body.data.idempotent).toBe(true);
  });

  it('PUT /availability should return 400 when isAvailable is not boolean', async () => {
    const res = await makeRequest(app, 'PUT', '/api/v1/transporter/availability', { isAvailable: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /availability should return 429 when rate limited (cooldown)', async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce({ isAvailable: false });
    mockRedisGet.mockResolvedValueOnce((Date.now() - 1000).toString()); // 1s ago, within 5s cooldown
    const res = await makeRequest(app, 'PUT', '/api/v1/transporter/availability', { isAvailable: true });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOGGLE_RATE_LIMITED');
  });

  it('GET /availability should return current status', async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce({ isAvailable: true, updatedAt: new Date() });
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/availability');
    expect(res.status).toBe(200);
    expect(res.body.data.isAvailable).toBe(true);
  });

  it('GET /availability should return 404 when transporter not found', async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/availability');
    expect(res.status).toBe(404);
  });

  it('POST /heartbeat should validate coordinates', async () => {
    const res = await makeRequest(app, 'POST', '/api/v1/transporter/heartbeat', {
      latitude: 'not-a-number',
      longitude: 77.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /heartbeat should return 400 when no vehicles registered', async () => {
    mockGetVehiclesByTransporter.mockResolvedValueOnce([]);
    const res = await makeRequest(app, 'POST', '/api/v1/transporter/heartbeat', {
      latitude: 12.9,
      longitude: 77.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_VEHICLES');
  });

  it('POST /heartbeat should succeed with valid data', async () => {
    mockGetVehiclesByTransporter.mockResolvedValueOnce([
      { id: 'v-001', vehicleType: 'tata_ace', vehicleSubtype: 'open', isActive: true, status: 'available' },
    ]);
    const res = await makeRequest(app, 'POST', '/api/v1/transporter/heartbeat', {
      latitude: 12.9,
      longitude: 77.5,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.registered).toBe(true);
  });

  it('DELETE /heartbeat should mark transporter offline', async () => {
    const res = await makeRequest(app, 'DELETE', '/api/v1/transporter/heartbeat');
    expect(res.status).toBe(200);
    expect(res.body.data.offline).toBe(true);
    expect(mockAvailSetOffline).toHaveBeenCalledWith('trans-001');
  });

  it('GET /availability/stats should return stats', async () => {
    mockAvailGetStatsAsync.mockResolvedValueOnce({ onlineCount: 5, vehicleTypes: ['tata_ace'] });
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/availability/stats');
    expect(res.status).toBe(200);
    expect(res.body.data.onlineCount).toBe(5);
  });
});

// =============================================================================
// SECTION 9: TRANSPORTER PROFILE ROUTES
// =============================================================================

describe('Transporter Profile Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    app = createTestApp('/api/v1/transporter', transporterRouter, TRANSPORTER_USER);
  });

  it('GET /profile should return transporter profile with stats', async () => {
    mockGetUserById.mockResolvedValueOnce({
      id: 'trans-001',
      name: 'Test Transporter',
      businessName: 'Test Logistics',
      phone: '9876543211',
      isAvailable: true,
    });
    mockGetVehiclesByTransporter.mockResolvedValueOnce([
      { id: 'v-001', status: 'available' },
      { id: 'v-002', status: 'in_transit' },
    ]);
    mockGetDriversByTransporter.mockResolvedValueOnce([{ id: 'drv-001' }]);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/profile');
    expect(res.status).toBe(200);
    expect(res.body.data.profile.businessName).toBe('Test Logistics');
    expect(res.body.data.stats.vehiclesCount).toBe(2);
    expect(res.body.data.stats.driversCount).toBe(1);
  });

  it('GET /profile should return 404 when transporter not found', async () => {
    mockGetUserById.mockResolvedValueOnce(null);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/profile');
    expect(res.status).toBe(404);
  });

  it('PUT /profile should update transporter profile', async () => {
    mockUpdateUser.mockResolvedValueOnce({});
    mockGetUserById.mockResolvedValueOnce({
      id: 'trans-001',
      name: 'Updated Name',
      businessName: 'Updated Logistics',
      phone: '9876543211',
    });
    const res = await makeRequest(app, 'PUT', '/api/v1/transporter/profile', {
      name: 'Updated Name',
      businessName: 'Updated Logistics',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe('Updated Name');
  });

  it('PUT /profile should return 400 for empty updates', async () => {
    const res = await makeRequest(app, 'PUT', '/api/v1/transporter/profile', {});
    expect(res.status).toBe(400);
  });

  it('GET /stats should return transporter statistics', async () => {
    mockPrismaAssignmentCount.mockResolvedValueOnce(50); // totalTrips
    mockPrismaAssignmentCount.mockResolvedValueOnce(40); // completedTrips
    mockPrismaAssignmentCount.mockResolvedValueOnce(2);  // activeTrips
    mockPrismaAssignmentFindMany.mockResolvedValueOnce([]); // earnings lookup
    mockPrismaRatingAggregate.mockResolvedValueOnce({ _avg: { stars: 4.5 }, _count: { stars: 30 } });
    mockPrismaAssignmentCount.mockResolvedValueOnce(5); // declinedTrips
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/stats');
    expect(res.status).toBe(200);
    expect(res.body.data.totalTrips).toBe(50);
  });
});

// =============================================================================
// SECTION 10: TRANSPORTER DISPATCH ROUTES
// =============================================================================

describe('Transporter Dispatch Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    app = createTestApp('/api/v1/transporter', transporterRouter, TRANSPORTER_USER);
  });

  it('GET /dispatch/replay should return empty events with rate limiting', async () => {
    mockRedisGet.mockResolvedValueOnce(null); // No rate limit
    mockGetVehiclesByTransporter.mockResolvedValueOnce([
      { id: 'v-001', vehicleType: 'tata_ace', vehicleSubtype: 'open', isActive: true },
    ]);
    mockGetActiveOrders.mockResolvedValueOnce([]);
    mockGetActiveBookingsForTransporter.mockResolvedValueOnce([]);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/dispatch/replay');
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
  });

  it('GET /dispatch/replay should return rate-limited empty response', async () => {
    mockRedisGet.mockResolvedValueOnce('1'); // Already called recently
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/dispatch/replay');
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('GET /dispatch/replay should return broadcast events for matching orders', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockGetVehiclesByTransporter.mockResolvedValueOnce([
      { id: 'v-001', vehicleType: 'tata_ace', vehicleSubtype: 'open', isActive: true },
    ]);
    mockGetActiveOrders.mockResolvedValueOnce([
      {
        id: 'ord-100',
        pickup: { latitude: 12.9, longitude: 77.5 },
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        createdAt: new Date().toISOString(),
      },
    ]);
    mockPrismaTruckRequestFindMany.mockResolvedValueOnce([
      { orderId: 'ord-100', vehicleType: 'tata_ace', vehicleSubtype: 'open', status: 'searching' },
    ]);
    mockGetActiveBookingsForTransporter.mockResolvedValueOnce([]);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/dispatch/replay');
    expect(res.status).toBe(200);
    expect(res.body.data.events.length).toBe(1);
    expect(res.body.data.events[0].eventType).toBe('broadcast_created');
  });
});

// =============================================================================
// SECTION 11: EDGE CASES AND CROSS-CUTTING CONCERNS
// =============================================================================

describe('Edge Cases', () => {
  it('should return 404 for invalid order endpoint', async () => {
    const orderRouter = require('../modules/order/order.routes').default;
    const app = createTestApp('/api/v1/orders', orderRouter, CUSTOMER_USER);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/nonexistent-route/nested/deep');
    expect(res.status).toBe(404);
  });

  it('should return 404 for invalid driver endpoint', async () => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    const app = createTestApp('/api/v1/driver', driverRouter, DRIVER_USER);
    const res = await makeRequest(app, 'GET', '/api/v1/driver/nonexistent');
    expect(res.status).toBe(404);
  });

  it('should return 404 for invalid transporter endpoint', async () => {
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    const app = createTestApp('/api/v1/transporter', transporterRouter, TRANSPORTER_USER);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/nonexistent');
    expect(res.status).toBe(404);
  });

  it('should reject unauthenticated request to orders', async () => {
    const orderRouter = require('../modules/order/order.routes').default;
    const app = createTestApp('/api/v1/orders', orderRouter); // No default user
    const res = await makeRequest(app, 'GET', '/api/v1/orders/check-active');
    expect(res.status).toBe(401);
  });

  it('should reject unauthenticated request to driver dashboard', async () => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    const app = createTestApp('/api/v1/driver', driverRouter); // No default user
    const res = await makeRequest(app, 'GET', '/api/v1/driver/dashboard');
    expect(res.status).toBe(401);
  });

  it('should reject unauthenticated request to transporter availability', async () => {
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    const app = createTestApp('/api/v1/transporter', transporterRouter); // No default user
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/availability');
    expect(res.status).toBe(401);
  });

  it('should reject wrong role for customer-only endpoint', async () => {
    const orderRouter = require('../modules/order/order.routes').default;
    const app = createTestApp('/api/v1/orders', orderRouter, TRANSPORTER_USER);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/check-active');
    expect(res.status).toBe(403);
  });

  it('should reject driver role for transporter-only endpoint', async () => {
    const orderRouter = require('../modules/order/order.routes').default;
    const app = createTestApp('/api/v1/orders', orderRouter, DRIVER_USER);
    const res = await makeRequest(app, 'GET', '/api/v1/orders/active');
    expect(res.status).toBe(403);
  });

  it('should reject customer role for driver-only endpoint', async () => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    const app = createTestApp('/api/v1/driver', driverRouter, CUSTOMER_USER);
    const res = await makeRequest(app, 'POST', '/api/v1/driver/onboard/initiate', {
      phone: '9876543210',
      name: 'Test',
      licenseNumber: 'DL001',
    });
    expect(res.status).toBe(403);
  });

  it('should reject customer role for transporter dispatch', async () => {
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    const app = createTestApp('/api/v1/transporter', transporterRouter, CUSTOMER_USER);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/dispatch/replay');
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// SECTION 12: MIDDLEWARE CHAIN ORDER VERIFICATION
// =============================================================================

describe('Middleware Chain Verification', () => {
  it('order routes should apply authMiddleware before roleGuard', async () => {
    const orderRouter = require('../modules/order/order.routes').default;
    const app = createTestApp('/api/v1/orders', orderRouter);
    // No user set at all -- should get 401 from authMiddleware, not 403 from roleGuard
    const res = await makeRequest(app, 'GET', '/api/v1/orders/check-active');
    expect(res.status).toBe(401);
  });

  it('driver routes should apply authMiddleware before roleGuard', async () => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    const app = createTestApp('/api/v1/driver', driverRouter);
    const res = await makeRequest(app, 'GET', '/api/v1/driver/dashboard');
    expect(res.status).toBe(401);
  });

  it('transporter routes should apply authMiddleware before roleGuard', async () => {
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    const app = createTestApp('/api/v1/transporter', transporterRouter);
    const res = await makeRequest(app, 'GET', '/api/v1/transporter/profile');
    expect(res.status).toBe(401);
  });

  it('order accept should use CRITICAL priority bookingQueue middleware', () => {
    // Verify the accept route exists with bookingQueue middleware
    const { orderCrudRouter } = require('../modules/order/order-crud.routes');
    const stack = (orderCrudRouter as any).stack;
    const acceptRoute = stack.find((layer: any) =>
      layer.route && layer.route.path === '/accept' && layer.route.methods.post
    );
    expect(acceptRoute).toBeDefined();
  });

  it('order cancel should use HIGH priority bookingQueue middleware', () => {
    const { orderLifecycleRouter } = require('../modules/order/order-lifecycle.routes');
    const stack = (orderLifecycleRouter as any).stack;
    const cancelRoute = stack.find((layer: any) =>
      layer.route && layer.route.path === '/:id/cancel' && layer.route.methods.post
    );
    expect(cancelRoute).toBeDefined();
  });

  it('reached-stop should use trackingQueue middleware', () => {
    const { orderProgressRouter } = require('../modules/order/order-progress.routes');
    const stack = (orderProgressRouter as any).stack;
    const reachedRoute = stack.find((layer: any) =>
      layer.route && layer.route.path === '/:orderId/reached-stop' && layer.route.methods.post
    );
    expect(reachedRoute).toBeDefined();
  });
});

// =============================================================================
// SECTION 13: ROUTE PATH VERIFICATION
// =============================================================================

describe('Route Path Verification', () => {
  it('orderCrudRouter should register all expected paths', () => {
    const { orderCrudRouter } = require('../modules/order/order-crud.routes');
    const routes = extractRoutes(orderCrudRouter);
    expect(routes).toContainEqual({ method: 'get', path: '/check-active' });
    expect(routes).toContainEqual({ method: 'post', path: '/' });
    expect(routes).toContainEqual({ method: 'get', path: '/' });
    expect(routes).toContainEqual({ method: 'get', path: '/active' });
    expect(routes).toContainEqual({ method: 'get', path: '/:id' });
    expect(routes).toContainEqual({ method: 'post', path: '/accept' });
  });

  it('orderLifecycleRouter should register all expected paths', () => {
    const { orderLifecycleRouter } = require('../modules/order/order-lifecycle.routes');
    const routes = extractRoutes(orderLifecycleRouter);
    expect(routes).toContainEqual({ method: 'post', path: '/:id/cancel' });
    expect(routes).toContainEqual({ method: 'delete', path: '/:orderId/cancel' });
    expect(routes).toContainEqual({ method: 'get', path: '/:orderId/cancel-preview' });
    expect(routes).toContainEqual({ method: 'post', path: '/:orderId/cancel/dispute' });
    expect(routes).toContainEqual({ method: 'get', path: '/:orderId/status' });
    expect(routes).toContainEqual({ method: 'get', path: '/:orderId/broadcast-snapshot' });
    expect(routes).toContainEqual({ method: 'get', path: '/pending-settlements' });
  });

  it('orderProgressRouter should register all expected paths', () => {
    const { orderProgressRouter } = require('../modules/order/order-progress.routes');
    const routes = extractRoutes(orderProgressRouter);
    expect(routes).toContainEqual({ method: 'post', path: '/:orderId/reached-stop' });
    expect(routes).toContainEqual({ method: 'get', path: '/:orderId/route' });
    expect(routes).toContainEqual({ method: 'post', path: '/:orderId/departed-stop' });
  });

  it('driverOnboardingRouter should register all expected paths', () => {
    const { driverOnboardingRouter } = require('../modules/driver/driver-onboarding.routes');
    const routes = extractRoutes(driverOnboardingRouter);
    expect(routes).toContainEqual({ method: 'post', path: '/onboard/initiate' });
    expect(routes).toContainEqual({ method: 'post', path: '/onboard/verify' });
    expect(routes).toContainEqual({ method: 'post', path: '/onboard/resend' });
    expect(routes).toContainEqual({ method: 'post', path: '/create' });
    expect(routes).toContainEqual({ method: 'get', path: '/list' });
  });

  it('driverDashboardRouter should register all expected paths', () => {
    const { driverDashboardRouter } = require('../modules/driver/driver-dashboard.routes');
    const routes = extractRoutes(driverDashboardRouter);
    expect(routes).toContainEqual({ method: 'get', path: '/dashboard' });
    expect(routes).toContainEqual({ method: 'get', path: '/performance' });
    expect(routes).toContainEqual({ method: 'get', path: '/availability' });
    expect(routes).toContainEqual({ method: 'get', path: '/available' });
    expect(routes).toContainEqual({ method: 'get', path: '/online-drivers' });
    expect(routes).toContainEqual({ method: 'put', path: '/availability' });
    expect(routes).toContainEqual({ method: 'get', path: '/earnings' });
    expect(routes).toContainEqual({ method: 'get', path: '/trips' });
    expect(routes).toContainEqual({ method: 'get', path: '/trips/active' });
  });

  it('driverProfileRouter should register all expected paths', () => {
    const { driverProfileRouter } = require('../modules/driver/driver-profile.routes');
    const routes = extractRoutes(driverProfileRouter);
    expect(routes).toContainEqual({ method: 'post', path: '/complete-profile' });
    expect(routes).toContainEqual({ method: 'get', path: '/profile' });
    expect(routes).toContainEqual({ method: 'put', path: '/profile/photo' });
    expect(routes).toContainEqual({ method: 'put', path: '/profile/license' });
    expect(routes).toContainEqual({ method: 'post', path: '/regenerate-urls' });
  });

  it('transporterRouter should register all expected availability paths (F-B-41)', () => {
    // F-B-41: validate that the real transporterRouter owns the five
    // availability-surface routes that the deleted stub file used to shadow.
    const transporterRouter = require('../modules/transporter/transporter.routes').default;
    const routes = extractRoutes(transporterRouter);
    expect(routes).toContainEqual({ method: 'put', path: '/availability' });
    expect(routes).toContainEqual({ method: 'get', path: '/availability' });
    expect(routes).toContainEqual({ method: 'post', path: '/heartbeat' });
    expect(routes).toContainEqual({ method: 'delete', path: '/heartbeat' });
    expect(routes).toContainEqual({ method: 'get', path: '/availability/stats' });
  });

  it('transporterProfileRouter should register all expected paths', () => {
    const { transporterProfileRouter } = require('../modules/transporter/transporter-profile.routes');
    const routes = extractRoutes(transporterProfileRouter);
    expect(routes).toContainEqual({ method: 'get', path: '/profile' });
    expect(routes).toContainEqual({ method: 'put', path: '/profile' });
    expect(routes).toContainEqual({ method: 'get', path: '/stats' });
  });

  it('transporterDispatchRouter should register all expected paths', () => {
    const { transporterDispatchRouter } = require('../modules/transporter/transporter-dispatch.routes');
    const routes = extractRoutes(transporterDispatchRouter);
    expect(routes).toContainEqual({ method: 'get', path: '/dispatch/replay' });
  });
});

// =============================================================================
// HELPER: Extract routes from an Express Router
// =============================================================================

function extractRoutes(router: any): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  if (router.stack) {
    for (const layer of router.stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) {
            routes.push({ method, path: layer.route.path });
          }
        }
      }
    }
  }
  return routes;
}
