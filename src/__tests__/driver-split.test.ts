/**
 * =============================================================================
 * DRIVER SPLIT MODULE - Comprehensive Tests
 * =============================================================================
 *
 * Tests for the split driver service architecture:
 *   - driver.service.ts        (facade, 61 lines)
 *   - driver.types.ts          (shared types, 72 lines)
 *   - driver-management.service.ts  (CRUD, profile, photos)
 *   - driver-performance.service.ts (dashboard, earnings, trips)
 *   - driver-presence.service.ts    (online/offline, heartbeat, toggle)
 *
 * Coverage areas:
 *   1. Facade integrity & type exports
 *   2. Management: create, list, profile, photos
 *   3. Performance: dashboard, earnings, trips, metrics
 *   4. Presence: go online/offline, heartbeat, toggle spam, availability
 *   5. Edge cases & stress scenarios
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP - Must come before imports
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetUserByPhone = jest.fn();
const mockCreateUser = jest.fn();
const mockGetDriversByTransporter = jest.fn();
const mockGetVehiclesByTransporter = jest.fn();
const mockGetBookingsByDriver = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../shared/database/db', () => ({
  db: {
    getUserByPhone: (...args: any[]) => mockGetUserByPhone(...args),
    createUser: (...args: any[]) => mockCreateUser(...args),
    getDriversByTransporter: (...args: any[]) => mockGetDriversByTransporter(...args),
    getVehiclesByTransporter: (...args: any[]) => mockGetVehiclesByTransporter(...args),
    getBookingsByDriver: (...args: any[]) => mockGetBookingsByDriver(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
}));

const mockPrismaUserUpdate = jest.fn();
const mockPrismaUserFindUnique = jest.fn();
const mockPrismaUserFindMany = jest.fn();
const mockPrismaAssignmentCount = jest.fn();
const mockPrismaAssignmentFindMany = jest.fn();
const mockPrismaBookingFindMany = jest.fn();
const mockPrismaOrderFindMany = jest.fn();
const mockPrismaRatingAggregate = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: {
      update: (...args: any[]) => mockPrismaUserUpdate(...args),
      findUnique: (...args: any[]) => mockPrismaUserFindUnique(...args),
      findMany: (...args: any[]) => mockPrismaUserFindMany(...args),
    },
    assignment: {
      count: (...args: any[]) => mockPrismaAssignmentCount(...args),
      findMany: (...args: any[]) => mockPrismaAssignmentFindMany(...args),
    },
    booking: {
      findMany: (...args: any[]) => mockPrismaBookingFindMany(...args),
    },
    order: {
      findMany: (...args: any[]) => mockPrismaOrderFindMany(...args),
    },
    rating: {
      aggregate: (...args: any[]) => mockPrismaRatingAggregate(...args),
    },
  },
}));

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisExists = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisCheckRateLimit = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sRem: (...args: any[]) => mockRedisSRem(...args),
    sMembers: (...args: any[]) => mockRedisSMembers(...args),
    checkRateLimit: (...args: any[]) => mockRedisCheckRateLimit(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
  },
}));

const mockEmitToUser = jest.fn();

jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
  },
}));

const mockInvalidateDriverCache = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/fleet-cache.service', () => ({
  fleetCacheService: {
    invalidateDriverCache: (...args: any[]) => mockInvalidateDriverCache(...args),
  },
}));

jest.mock('../shared/utils/safe-json.utils', () => ({
  safeJsonParse: <T>(value: string | null | undefined, fallback: T): T => {
    if (value == null) return fallback;
    try { return JSON.parse(value) as T; }
    catch { return fallback; }
  },
}));

// =============================================================================
// IMPORTS - After mocks
// =============================================================================

import { driverService } from '../modules/driver/driver.service';
import { driverManagementService } from '../modules/driver/driver-management.service';
import { driverPerformanceService } from '../modules/driver/driver-performance.service';
import { driverPresenceService } from '../modules/driver/driver-presence.service';
import { AppError } from '../shared/types/error.types';
import type { DashboardData, AvailabilityData, EarningsData, PerformanceData } from '../modules/driver/driver.types';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

const DRIVER_ID = 'driver-001';
const TRANSPORTER_ID = 'transporter-001';

const makeDriver = (overrides: Record<string, any> = {}) => ({
  id: DRIVER_ID,
  phone: '9876543210',
  role: 'driver' as const,
  name: 'Test Driver',
  email: 'driver@test.com',
  transporterId: TRANSPORTER_ID,
  licenseNumber: 'DL1234567890',
  isVerified: false,
  isActive: true,
  isAvailable: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeBooking = (overrides: Record<string, any> = {}) => ({
  id: `booking-${Math.random().toString(36).slice(2, 8)}`,
  customerId: 'customer-001',
  customerName: 'Test Customer',
  customerPhone: '9999999999',
  pickup: { latitude: 12.97, longitude: 77.59, address: '100 Feet Road, Bangalore' },
  drop: { latitude: 13.03, longitude: 77.63, address: 'Whitefield, Bangalore' },
  vehicleType: 'tata_ace',
  vehicleSubtype: 'open',
  trucksNeeded: 1,
  trucksFilled: 1,
  distanceKm: 15,
  pricePerTruck: 1500,
  totalAmount: 1500,
  status: 'completed',
  notifiedTransporters: [] as any[],
  expiresAt: '2026-12-31T00:00:00.000Z',
  createdAt: '2026-04-01T10:00:00.000Z',
  updatedAt: '2026-04-01T12:00:00.000Z',
  ...overrides,
});

const makeVehicle = (overrides: Record<string, any> = {}) => ({
  id: `vehicle-${Math.random().toString(36).slice(2, 8)}`,
  transporterId: TRANSPORTER_ID,
  vehicleNumber: 'KA01AB1234',
  vehicleType: 'tata_ace',
  vehicleSubtype: 'open',
  vehicleKey: 'tata_ace_open',
  capacity: '1 ton',
  status: 'available',
  ...overrides,
});

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();

  // Default Redis mocks
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue(undefined);
  mockRedisDel.mockResolvedValue(undefined);
  mockRedisExists.mockResolvedValue(false);
  mockRedisSAdd.mockResolvedValue(undefined);
  mockRedisSRem.mockResolvedValue(undefined);
  mockRedisSMembers.mockResolvedValue([]);
  mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
  mockRedisAcquireLock.mockResolvedValue({ acquired: true });
  mockRedisReleaseLock.mockResolvedValue(true);

  // Default Prisma mocks
  mockPrismaUserUpdate.mockResolvedValue(makeDriver());
  mockPrismaUserFindUnique.mockResolvedValue(makeDriver());
  mockPrismaUserFindMany.mockResolvedValue([]);
  mockPrismaAssignmentCount.mockResolvedValue(0);
  mockPrismaAssignmentFindMany.mockResolvedValue([]);
  mockPrismaBookingFindMany.mockResolvedValue([]);
  mockPrismaOrderFindMany.mockResolvedValue([]);
  mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });

  // Default db mocks
  mockGetUserByPhone.mockResolvedValue(null);
  mockCreateUser.mockResolvedValue(makeDriver());
  mockGetDriversByTransporter.mockResolvedValue([]);
  mockGetVehiclesByTransporter.mockResolvedValue([]);
  mockGetBookingsByDriver.mockResolvedValue([]);
  mockGetUserById.mockResolvedValue(makeDriver());
  mockUpdateUser.mockResolvedValue(makeDriver());
}

// =============================================================================
// SECTION 1: FACADE INTEGRITY
// =============================================================================

describe('Driver Service Facade', () => {
  beforeEach(resetAllMocks);

  test('1.1 - exports all presence methods from driverPresenceService', () => {
    expect(typeof driverService.goOnline).toBe('function');
    expect(typeof driverService.goOffline).toBe('function');
    expect(typeof driverService.handleHeartbeat).toBe('function');
    expect(typeof driverService.restorePresence).toBe('function');
    expect(typeof driverService.isDriverOnline).toBe('function');
    expect(typeof driverService.areDriversOnline).toBe('function');
    expect(typeof driverService.getOnlineDriverIds).toBe('function');
    expect(typeof driverService.getAvailability).toBe('function');
    expect(typeof driverService.updateAvailability).toBe('function');
  });

  test('1.2 - exports all performance methods from driverPerformanceService', () => {
    expect(typeof driverService.getPerformance).toBe('function');
    expect(typeof driverService.getDashboard).toBe('function');
    expect(typeof driverService.getEarnings).toBe('function');
    expect(typeof driverService.getTrips).toBe('function');
    expect(typeof driverService.getActiveTrip).toBe('function');
  });

  test('1.3 - exports all management methods from driverManagementService', () => {
    expect(typeof driverService.createDriver).toBe('function');
    expect(typeof driverService.getTransporterDrivers).toBe('function');
    expect(typeof driverService.completeProfile).toBe('function');
    expect(typeof driverService.getDriverById).toBe('function');
    expect(typeof driverService.updateProfilePhoto).toBe('function');
    expect(typeof driverService.updateLicensePhotos).toBe('function');
  });

  test('1.4 - facade delegates goOnline to driverPresenceService', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(makeDriver({ transporterId: TRANSPORTER_ID, name: 'Test' }));
    const result = await driverService.goOnline(DRIVER_ID);
    expect(result.isOnline).toBe(true);
    expect(mockPrismaUserUpdate).toHaveBeenCalled();
  });

  test('1.5 - facade delegates createDriver to driverManagementService', async () => {
    const newDriver = makeDriver({ name: 'New Driver' });
    mockCreateUser.mockResolvedValue(newDriver);
    mockGetDriversByTransporter.mockResolvedValue([newDriver]);
    mockGetVehiclesByTransporter.mockResolvedValue([]);

    const result = await driverService.createDriver(TRANSPORTER_ID, {
      phone: '9876543210',
      name: 'New Driver',
      licenseNumber: 'DL001',
    });
    expect(result.name).toBe('New Driver');
  });

  test('1.6 - facade delegates getDashboard to driverPerformanceService', async () => {
    mockGetBookingsByDriver.mockResolvedValue([]);
    mockRedisExists.mockResolvedValue(false);
    const result = await driverService.getDashboard(DRIVER_ID);
    expect(result).toHaveProperty('stats');
    expect(result).toHaveProperty('recentTrips');
    expect(result).toHaveProperty('availability');
  });

  test('1.7 - type exports are accessible', () => {
    // Verify type exports compile correctly (compile-time check via usage)
    const dashboard: DashboardData = {
      stats: {
        totalTrips: 0, completedToday: 0, totalEarnings: 0, todayEarnings: 0,
        rating: 0, totalRatings: 0, acceptanceRate: 100, onTimeDeliveryRate: 100,
        totalDistance: 0, todayDistance: 0,
      },
      recentTrips: [],
      availability: { isOnline: false, lastOnline: null },
    };
    expect(dashboard.stats.totalTrips).toBe(0);

    const availability: AvailabilityData = {
      isOnline: true, lastUpdated: new Date().toISOString(),
    };
    expect(availability.isOnline).toBe(true);

    const earnings: EarningsData = {
      period: 'week', totalEarnings: 0, totalTrips: 0, averagePerTrip: 0,
      tripCount: 0, avgPerTrip: 0, breakdown: [],
    };
    expect(earnings.period).toBe('week');

    const perf: PerformanceData = {
      rating: 4.5, totalRatings: 10, acceptanceRate: 95,
      onTimeDeliveryRate: 90, completionRate: 88, totalTrips: 50, totalDistance: 500,
    };
    expect(perf.rating).toBe(4.5);
  });

  test('1.8 - .bind() preserves context for all facade methods', async () => {
    // goOffline needs prisma update + del + findUnique
    mockPrismaUserFindUnique.mockResolvedValue(makeDriver({ transporterId: TRANSPORTER_ID, name: 'Test' }));
    const goOfflineFn = driverService.goOffline;
    const result = await goOfflineFn(DRIVER_ID);
    expect(result.isOnline).toBe(false);
  });
});

// =============================================================================
// SECTION 2: MANAGEMENT TESTS (driver-management.service.ts)
// =============================================================================

describe('Driver Management Service', () => {
  beforeEach(resetAllMocks);

  test('2.1 - createDriver with valid data returns driver', async () => {
    const newDriver = makeDriver({ id: 'new-driver-id', name: 'Ravi Kumar' });
    mockCreateUser.mockResolvedValue(newDriver);
    mockGetDriversByTransporter.mockResolvedValue([newDriver]);
    mockGetVehiclesByTransporter.mockResolvedValue([]);

    const result = await driverManagementService.createDriver(TRANSPORTER_ID, {
      phone: '9876543210',
      name: 'Ravi Kumar',
      licenseNumber: 'DL9876543210',
    });

    expect(result.name).toBe('Ravi Kumar');
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(mockEmitToUser).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'driver_added',
      expect.objectContaining({
        driver: expect.objectContaining({ name: 'Ravi Kumar' }),
      })
    );
  });

  test('2.2 - createDriver with duplicate phone throws DRIVER_EXISTS', async () => {
    mockGetUserByPhone.mockResolvedValue(makeDriver());

    await expect(
      driverManagementService.createDriver(TRANSPORTER_ID, {
        phone: '9876543210',
        name: 'Duplicate',
        licenseNumber: 'DL111',
      })
    ).rejects.toThrow('A driver with this phone number already exists');
  });

  test('2.3 - createDriver emits socket event with driver stats', async () => {
    const newDriver = makeDriver({ name: 'Socket Driver' });
    mockCreateUser.mockResolvedValue(newDriver);
    const driversOnTrip = makeDriver({ id: 'driver-on-trip', isActive: true });
    const vehicleInTransit = makeVehicle({
      status: 'in_transit',
      assignedDriverId: 'driver-on-trip',
    });
    mockGetDriversByTransporter.mockResolvedValue([newDriver, driversOnTrip]);
    mockGetVehiclesByTransporter.mockResolvedValue([vehicleInTransit]);

    await driverManagementService.createDriver(TRANSPORTER_ID, {
      phone: '9999999999',
      name: 'Socket Driver',
      licenseNumber: 'DL222',
    });

    expect(mockEmitToUser).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'driver_added',
      expect.objectContaining({
        driverStats: expect.objectContaining({
          total: 2,
          onTrip: 1,
          available: 1,
        }),
      })
    );
  });

  test('2.4 - getTransporterDrivers returns drivers with stats', async () => {
    const drivers = [
      makeDriver({ id: 'd1', isActive: true }),
      makeDriver({ id: 'd2', isActive: true }),
      makeDriver({ id: 'd3', isActive: false }),
    ];
    const vehicles = [
      makeVehicle({ status: 'in_transit', assignedDriverId: 'd1' }),
    ];
    mockGetDriversByTransporter.mockResolvedValue(drivers);
    mockGetVehiclesByTransporter.mockResolvedValue(vehicles);

    const result = await driverManagementService.getTransporterDrivers(TRANSPORTER_ID);

    expect(result.total).toBe(2); // only active
    expect(result.onTrip).toBe(1);
    expect(result.available).toBe(1);
    expect(result.drivers).toHaveLength(2);
  });

  test('2.5 - getTransporterDrivers with empty fleet returns zeros', async () => {
    mockGetDriversByTransporter.mockResolvedValue([]);
    mockGetVehiclesByTransporter.mockResolvedValue([]);

    const result = await driverManagementService.getTransporterDrivers(TRANSPORTER_ID);

    expect(result.total).toBe(0);
    expect(result.available).toBe(0);
    expect(result.onTrip).toBe(0);
    expect(result.drivers).toHaveLength(0);
  });

  test('2.6 - completeProfile updates driver and invalidates cache', async () => {
    const updatedDriver = makeDriver({ isProfileCompleted: true, licenseNumber: 'DL999' });
    mockUpdateUser.mockResolvedValue(updatedDriver);

    const result = await driverManagementService.completeProfile(DRIVER_ID, {
      licenseNumber: 'DL999',
      vehicleType: 'tata_ace',
      address: '100 Feet Road',
      language: 'en',
      driverPhotoUrl: 'https://s3.example.com/photo.jpg',
      licenseFrontUrl: 'https://s3.example.com/front.jpg',
      licenseBackUrl: 'https://s3.example.com/back.jpg',
      isProfileCompleted: true,
    });

    expect(result.isProfileCompleted).toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledWith(DRIVER_ID, expect.objectContaining({
      licenseNumber: 'DL999',
      isProfileCompleted: true,
    }));
    expect(mockInvalidateDriverCache).toHaveBeenCalledWith(DRIVER_ID);
  });

  test('2.7 - completeProfile throws when driver not found', async () => {
    mockUpdateUser.mockResolvedValue(null);

    await expect(
      driverManagementService.completeProfile(DRIVER_ID, {
        licenseNumber: 'DL000',
        vehicleType: 'tata_ace',
        address: 'Test',
        language: 'en',
        driverPhotoUrl: 'url',
        licenseFrontUrl: 'url',
        licenseBackUrl: 'url',
        isProfileCompleted: true,
      })
    ).rejects.toThrow('Driver not found');
  });

  test('2.8 - getDriverById returns driver for valid ID', async () => {
    const driver = makeDriver({ profilePhoto: 'https://photo.jpg' });
    mockGetUserById.mockResolvedValue(driver);

    const result = await driverManagementService.getDriverById(DRIVER_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(DRIVER_ID);
  });

  test('2.9 - getDriverById returns null for non-driver user', async () => {
    mockGetUserById.mockResolvedValue({ ...makeDriver(), role: 'customer' });

    const result = await driverManagementService.getDriverById(DRIVER_ID);
    expect(result).toBeNull();
  });

  test('2.10 - getDriverById returns null when user not found', async () => {
    mockGetUserById.mockResolvedValue(null);

    const result = await driverManagementService.getDriverById('nonexistent');
    expect(result).toBeNull();
  });

  test('2.11 - updateProfilePhoto updates photo and invalidates cache', async () => {
    const updatedDriver = makeDriver({ profilePhoto: 'https://new-photo.jpg' });
    mockUpdateUser.mockResolvedValue(updatedDriver);

    const result = await driverManagementService.updateProfilePhoto(DRIVER_ID, 'https://new-photo.jpg');

    expect(result.profilePhoto).toBe('https://new-photo.jpg');
    expect(mockInvalidateDriverCache).toHaveBeenCalledWith(DRIVER_ID);
  });

  test('2.12 - updateProfilePhoto throws when driver not found', async () => {
    mockUpdateUser.mockResolvedValue(null);

    await expect(
      driverManagementService.updateProfilePhoto(DRIVER_ID, 'https://photo.jpg')
    ).rejects.toThrow('Driver not found');
  });

  test('2.13 - updateLicensePhotos updates front only', async () => {
    const updatedDriver = makeDriver({ licenseFrontPhoto: 'https://front.jpg' });
    mockUpdateUser.mockResolvedValue(updatedDriver);

    const result = await driverManagementService.updateLicensePhotos(DRIVER_ID, 'https://front.jpg');

    expect(result).toBeDefined();
    expect(mockUpdateUser).toHaveBeenCalledWith(DRIVER_ID, { licenseFrontPhoto: 'https://front.jpg' });
    expect(mockInvalidateDriverCache).toHaveBeenCalled();
  });

  test('2.14 - updateLicensePhotos updates both front and back', async () => {
    const updatedDriver = makeDriver();
    mockUpdateUser.mockResolvedValue(updatedDriver);

    await driverManagementService.updateLicensePhotos(DRIVER_ID, 'https://front.jpg', 'https://back.jpg');

    expect(mockUpdateUser).toHaveBeenCalledWith(DRIVER_ID, {
      licenseFrontPhoto: 'https://front.jpg',
      licenseBackPhoto: 'https://back.jpg',
    });
  });

  test('2.15 - updateLicensePhotos throws when driver not found', async () => {
    mockUpdateUser.mockResolvedValue(null);

    await expect(
      driverManagementService.updateLicensePhotos(DRIVER_ID, 'https://front.jpg')
    ).rejects.toThrow('Driver not found');
  });

  test('2.16 - createDriver handles async getUserByPhone result', async () => {
    // getUserByPhone returns a promise-like result
    mockGetUserByPhone.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(makeDriver());
    mockGetDriversByTransporter.mockResolvedValue([makeDriver()]);
    mockGetVehiclesByTransporter.mockResolvedValue([]);

    const result = await driverManagementService.createDriver(TRANSPORTER_ID, {
      phone: '1111111111',
      name: 'Async Driver',
      licenseNumber: 'DL-ASYNC',
    });

    expect(result).toBeDefined();
  });
});

// =============================================================================
// SECTION 3: PERFORMANCE TESTS (driver-performance.service.ts)
// =============================================================================

describe('Driver Performance Service', () => {
  beforeEach(resetAllMocks);

  // --- getPerformance ---

  test('3.1 - getPerformance returns metrics for driver with trips', async () => {
    // 10 total, 8 completed, 1 declined, 1 cancelled
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(10)  // total
      .mockResolvedValueOnce(8)   // completed
      .mockResolvedValueOnce(1)   // declined
      .mockResolvedValueOnce(1);  // cancelled

    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: 4.2 }, _count: { stars: 15 } });
    mockRedisGet.mockResolvedValue(null); // no cached rating

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    expect(result.totalTrips).toBe(10);
    expect(result.acceptanceRate).toBe(90); // (10-1)/10 * 100
    expect(result.rating).toBe(4.2);
    expect(result.totalRatings).toBe(15);
  });

  test('3.2 - getPerformance returns 100% rates for new driver (no trips)', async () => {
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    expect(result.totalTrips).toBe(0);
    expect(result.acceptanceRate).toBe(100);
    expect(result.completionRate).toBe(100);
    expect(result.onTimeDeliveryRate).toBe(100);
    expect(result.totalDistance).toBe(0);
  });

  test('3.3 - getPerformance throws on invalid driverId', async () => {
    await expect(driverPerformanceService.getPerformance('')).rejects.toThrow(AppError);
    await expect(driverPerformanceService.getPerformance(null as any)).rejects.toThrow(AppError);
  });

  test('3.4 - getPerformance uses cached rating from Redis', async () => {
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(JSON.stringify({ avg: 4.8, count: 25 }));

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    expect(result.rating).toBe(4.8);
    expect(result.totalRatings).toBe(25);
    expect(mockPrismaRatingAggregate).not.toHaveBeenCalled();
  });

  test('3.5 - getPerformance calculates completion rate correctly', async () => {
    // 20 total, 15 completed, 5 declined, 0 cancelled
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(20)  // total
      .mockResolvedValueOnce(15)  // completed
      .mockResolvedValueOnce(5)   // declined
      .mockResolvedValueOnce(0);  // cancelled

    mockPrismaAssignmentFindMany.mockResolvedValue([]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    // accepted = 20 - 5 = 15; completionRate = 15/15 * 100 = 100
    expect(result.completionRate).toBe(100);
    expect(result.acceptanceRate).toBe(75); // (20-5)/20 * 100
  });

  test('3.6 - getPerformance wraps prisma errors as INTERNAL_ERROR', async () => {
    mockPrismaAssignmentCount.mockRejectedValue(new Error('Prisma connection lost'));

    await expect(driverPerformanceService.getPerformance(DRIVER_ID))
      .rejects.toThrow(AppError);
  });

  // --- getDashboard ---

  test('3.7 - getDashboard returns data for driver with completed trips', async () => {
    const today = new Date().toISOString().split('T')[0];
    const bookings = [
      makeBooking({ status: 'completed', totalAmount: 1500, updatedAt: `${today}T10:00:00.000Z` }),
      makeBooking({ status: 'completed', totalAmount: 2000, updatedAt: `${today}T14:00:00.000Z` }),
      makeBooking({ status: 'active', totalAmount: 1000 }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisExists.mockResolvedValue(false);
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: false });

    const result = await driverPerformanceService.getDashboard(DRIVER_ID);

    expect(result.stats.totalTrips).toBe(2);
    expect(result.stats.completedToday).toBe(2);
    expect(result.stats.totalEarnings).toBe(3500);
    expect(result.stats.todayEarnings).toBe(3500);
    expect(result.recentTrips).toHaveLength(2);
  });

  test('3.8 - getDashboard returns empty data for new driver', async () => {
    mockGetBookingsByDriver.mockResolvedValue([]);
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisExists.mockResolvedValue(false);
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: false });

    const result = await driverPerformanceService.getDashboard(DRIVER_ID);

    expect(result.stats.totalTrips).toBe(0);
    expect(result.stats.totalEarnings).toBe(0);
    expect(result.recentTrips).toHaveLength(0);
    expect(result.availability.isOnline).toBe(false);
  });

  test('3.9 - getDashboard limits recent trips to 5', async () => {
    const bookings = Array.from({ length: 10 }, (_, i) =>
      makeBooking({ status: 'completed', totalAmount: 100 * (i + 1) })
    );
    mockGetBookingsByDriver.mockResolvedValue(bookings);
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisExists.mockResolvedValue(false);
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: false });

    const result = await driverPerformanceService.getDashboard(DRIVER_ID);

    expect(result.recentTrips).toHaveLength(5);
  });

  test('3.10 - getDashboard gracefully degrades when acceptance rate query fails', async () => {
    mockGetBookingsByDriver.mockResolvedValue([]);
    mockPrismaAssignmentCount.mockRejectedValue(new Error('DB timeout'));
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisExists.mockResolvedValue(false);
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: false });

    const result = await driverPerformanceService.getDashboard(DRIVER_ID);

    // Should still return dashboard, with default acceptance rate
    expect(result.stats.acceptanceRate).toBe(100);
  });

  // --- getEarnings ---

  test('3.11 - getEarnings returns weekly earnings breakdown', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const bookings = [
      makeBooking({
        status: 'completed',
        totalAmount: 2000,
        updatedAt: yesterday.toISOString(),
        createdAt: yesterday.toISOString(),
      }),
      makeBooking({
        status: 'completed',
        totalAmount: 3000,
        updatedAt: now.toISOString(),
        createdAt: now.toISOString(),
      }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getEarnings(DRIVER_ID, 'week');

    expect(result.period).toBe('week');
    expect(result.totalEarnings).toBe(5000);
    expect(result.totalTrips).toBe(2);
    expect(result.averagePerTrip).toBe(2500);
    expect(result.breakdown.length).toBeGreaterThanOrEqual(1);
  });

  test('3.12 - getEarnings returns empty data when no completed bookings', async () => {
    mockGetBookingsByDriver.mockResolvedValue([
      makeBooking({ status: 'cancelled' }),
    ]);

    const result = await driverPerformanceService.getEarnings(DRIVER_ID, 'week');

    expect(result.totalEarnings).toBe(0);
    expect(result.totalTrips).toBe(0);
    expect(result.averagePerTrip).toBe(0);
  });

  test('3.13 - getEarnings supports today period', async () => {
    const today = new Date();
    const bookings = [
      makeBooking({
        status: 'completed',
        totalAmount: 1000,
        updatedAt: today.toISOString(),
        createdAt: today.toISOString(),
      }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getEarnings(DRIVER_ID, 'today');
    expect(result.period).toBe('today');
    expect(result.totalEarnings).toBe(1000);
  });

  test('3.14 - getEarnings supports month period', async () => {
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
    const bookings = [
      makeBooking({
        status: 'completed',
        totalAmount: 5000,
        updatedAt: thisMonth.toISOString(),
        createdAt: thisMonth.toISOString(),
      }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getEarnings(DRIVER_ID, 'month');
    expect(result.period).toBe('month');
  });

  test('3.15 - getEarnings defaults to week for unknown period', async () => {
    mockGetBookingsByDriver.mockResolvedValue([]);

    const result = await driverPerformanceService.getEarnings(DRIVER_ID, 'invalid-period');
    expect(result.period).toBe('invalid-period');
    // Still functions, just uses default date range
  });

  test('3.16 - getEarnings includes backward-compat fields', async () => {
    mockGetBookingsByDriver.mockResolvedValue([]);
    const result = await driverPerformanceService.getEarnings(DRIVER_ID);
    expect(result).toHaveProperty('tripCount');
    expect(result).toHaveProperty('avgPerTrip');
    expect(result.tripCount).toBe(result.totalTrips);
    expect(result.avgPerTrip).toBe(result.averagePerTrip);
  });

  // --- getTrips ---

  test('3.17 - getTrips returns paginated trips', async () => {
    const bookings = Array.from({ length: 15 }, (_, i) =>
      makeBooking({ id: `b-${i}`, status: 'completed', createdAt: new Date(2026, 0, i + 1).toISOString() })
    );
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getTrips(DRIVER_ID, {
      limit: 5, offset: 0,
    });

    expect(result.trips).toHaveLength(5);
    expect(result.total).toBe(15);
    expect(result.hasMore).toBe(true);
  });

  test('3.18 - getTrips filters by status', async () => {
    const bookings = [
      makeBooking({ status: 'completed' }),
      makeBooking({ status: 'cancelled' }),
      makeBooking({ status: 'completed' }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getTrips(DRIVER_ID, {
      status: 'completed', limit: 10, offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.trips.every((t: any) => t.status === 'completed')).toBe(true);
  });

  test('3.19 - getTrips returns hasMore=false when all trips fit', async () => {
    mockGetBookingsByDriver.mockResolvedValue([makeBooking()]);

    const result = await driverPerformanceService.getTrips(DRIVER_ID, {
      limit: 10, offset: 0,
    });

    expect(result.hasMore).toBe(false);
  });

  // --- getActiveTrip ---

  test('3.20 - getActiveTrip returns active trip', async () => {
    const bookings = [
      makeBooking({ status: 'completed' }),
      makeBooking({ id: 'active-1', status: 'active', totalAmount: 2500 }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getActiveTrip(DRIVER_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('active-1');
    expect(result!.price).toBe(2500);
  });

  test('3.21 - getActiveTrip returns null when no active trip', async () => {
    mockGetBookingsByDriver.mockResolvedValue([
      makeBooking({ status: 'completed' }),
    ]);

    const result = await driverPerformanceService.getActiveTrip(DRIVER_ID);
    expect(result).toBeNull();
  });

  test('3.22 - getActiveTrip recognizes partially_filled status', async () => {
    mockGetBookingsByDriver.mockResolvedValue([
      makeBooking({ id: 'pf-1', status: 'partially_filled' }),
    ]);

    const result = await driverPerformanceService.getActiveTrip(DRIVER_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('pf-1');
  });

  test('3.23 - getActiveTrip recognizes in_progress status', async () => {
    mockGetBookingsByDriver.mockResolvedValue([
      makeBooking({ id: 'ip-1', status: 'in_progress' }),
    ]);

    const result = await driverPerformanceService.getActiveTrip(DRIVER_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('ip-1');
  });

  // --- on-time rate calculation ---

  test('3.24 - on-time rate calculation with assignments having timestamps', async () => {
    // Create a scenario: 2 completed assignments, 1 on-time, 1 late
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(2)  // total
      .mockResolvedValueOnce(2)  // completed
      .mockResolvedValueOnce(0)  // declined
      .mockResolvedValueOnce(0); // cancelled

    const onTimeStart = new Date('2026-04-01T10:00:00Z');
    const onTimeEnd = new Date('2026-04-01T10:30:00Z');     // 30min for 5km = on-time
    const lateStart = new Date('2026-04-01T12:00:00Z');
    const lateEnd = new Date('2026-04-01T16:00:00Z');       // 4h for 5km = late

    mockPrismaAssignmentFindMany.mockResolvedValue([
      { bookingId: 'b1', orderId: null, startedAt: onTimeStart, completedAt: onTimeEnd },
      { bookingId: 'b2', orderId: null, startedAt: lateStart, completedAt: lateEnd },
    ]);
    mockPrismaBookingFindMany.mockResolvedValue([
      { id: 'b1', distanceKm: 5 },
      { id: 'b2', distanceKm: 5 },
    ]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    // 1 out of 2 on time = 50%
    expect(result.onTimeDeliveryRate).toBe(50);
  });

  test('3.25 - on-time rate defaults to 100% when no assignments have timestamps', async () => {
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    mockPrismaAssignmentFindMany.mockResolvedValue([
      { bookingId: 'b1', orderId: null, startedAt: null, completedAt: null },
    ]);
    mockPrismaBookingFindMany.mockResolvedValue([{ id: 'b1', distanceKm: 10 }]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);
    expect(result.onTimeDeliveryRate).toBe(100);
  });
});

// =============================================================================
// SECTION 4: PRESENCE TESTS (driver-presence.service.ts)
// =============================================================================

describe('Driver Presence Service', () => {
  beforeEach(resetAllMocks);

  // --- goOnline ---

  test('4.1 - goOnline sets DB available, Redis presence, notifies transporter', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ transporterId: TRANSPORTER_ID, name: 'Online Driver' })
    );

    const result = await driverPresenceService.goOnline(DRIVER_ID);

    expect(result.isOnline).toBe(true);
    expect(mockPrismaUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DRIVER_ID },
        data: { isAvailable: true },
      })
    );
    expect(mockRedisSet).toHaveBeenCalled();
    expect(mockRedisSAdd).toHaveBeenCalled();
    expect(mockEmitToUser).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'driver_status_changed',
      expect.objectContaining({ isOnline: true, action: 'online' })
    );
    expect(mockInvalidateDriverCache).toHaveBeenCalled();
  });

  test('4.2 - goOnline rolls back DB when Redis fails', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('Redis down'));
    // Second call to prismaUserUpdate is the rollback
    mockPrismaUserUpdate
      .mockResolvedValueOnce({}) // first update (isAvailable: true)
      .mockResolvedValueOnce({}); // rollback (isAvailable: false)

    await expect(driverPresenceService.goOnline(DRIVER_ID)).rejects.toThrow();

    // Verify rollback was attempted
    expect(mockPrismaUserUpdate).toHaveBeenCalledTimes(2);
  });

  test('4.3 - goOnline continues when SADD fails (best-effort)', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ transporterId: TRANSPORTER_ID, name: 'Test' })
    );
    mockRedisSAdd.mockRejectedValueOnce(new Error('SADD failed'));

    const result = await driverPresenceService.goOnline(DRIVER_ID);

    // Should still succeed despite SADD failure
    expect(result.isOnline).toBe(true);
  });

  // --- goOffline ---

  test('4.4 - goOffline clears DB, Redis, notifies transporter', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ transporterId: TRANSPORTER_ID, name: 'Offline Driver' })
    );

    const result = await driverPresenceService.goOffline(DRIVER_ID);

    expect(result.isOnline).toBe(false);
    expect(mockPrismaUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { isAvailable: false },
      })
    );
    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockRedisSRem).toHaveBeenCalled();
    expect(mockEmitToUser).toHaveBeenCalledWith(
      TRANSPORTER_ID,
      'driver_status_changed',
      expect.objectContaining({ isOnline: false, action: 'offline' })
    );
  });

  test('4.5 - goOffline still returns result when driver has no transporter', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ transporterId: null })
    );

    const result = await driverPresenceService.goOffline(DRIVER_ID);

    expect(result.isOnline).toBe(false);
    // Should not try to SREM or emit (no transporter)
    expect(mockRedisSRem).not.toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  // --- handleHeartbeat ---

  test('4.6 - handleHeartbeat extends TTL when driver is online', async () => {
    mockRedisExists.mockResolvedValue(true);

    await driverPresenceService.handleHeartbeat(DRIVER_ID, {
      lat: 12.97, lng: 77.59, battery: 85, speed: 30,
    });

    // F-B-05: PRESENCE_TTL_SECONDS is now sourced from presence.config
    // (36 = 3 × 12s heartbeat). Import the canonical constant instead of a
    // literal to prevent silent drift.
    const { DRIVER_PRESENCE_TTL_SECONDS } = require('../shared/config/presence.config');
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(`driver:presence:${DRIVER_ID}`),
      expect.any(String),
      DRIVER_PRESENCE_TTL_SECONDS
    );
  });

  test('4.7 - handleHeartbeat ignores stale heartbeat when driver is offline', async () => {
    mockRedisExists.mockResolvedValue(false);

    await driverPresenceService.handleHeartbeat(DRIVER_ID, { lat: 12.97, lng: 77.59 });

    // Should NOT set anything in Redis
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  test('4.8 - handleHeartbeat does not throw on Redis errors', async () => {
    mockRedisExists.mockRejectedValue(new Error('Redis timeout'));

    // Should not throw
    await driverPresenceService.handleHeartbeat(DRIVER_ID, {});
  });

  // --- restorePresence ---

  test('4.9 - restorePresence restores online driver on reconnect', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ isAvailable: true, transporterId: TRANSPORTER_ID, name: 'Restored', updatedAt: new Date().toISOString() })
    );
    mockRedisGet.mockResolvedValue(null); // no throttle

    const result = await driverPresenceService.restorePresence(DRIVER_ID);

    expect(result).toBe(true);
    expect(mockRedisSet).toHaveBeenCalled();
    expect(mockRedisSAdd).toHaveBeenCalled();
  });

  test('4.10 - restorePresence returns false for offline driver', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ isAvailable: false, transporterId: TRANSPORTER_ID })
    );

    const result = await driverPresenceService.restorePresence(DRIVER_ID);
    expect(result).toBe(false);
  });

  test('4.11 - restorePresence throttles status emit within 10s', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ isAvailable: true, transporterId: TRANSPORTER_ID, name: 'Throttled', updatedAt: new Date().toISOString() })
    );
    mockRedisGet.mockResolvedValue('1'); // already emitted

    const result = await driverPresenceService.restorePresence(DRIVER_ID);

    expect(result).toBe(true);
    // Should NOT emit because throttle key exists
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  test('4.12 - restorePresence returns false on error', async () => {
    mockPrismaUserFindUnique.mockRejectedValue(new Error('DB down'));

    const result = await driverPresenceService.restorePresence(DRIVER_ID);
    expect(result).toBe(false);
  });

  // --- isDriverOnline ---

  test('4.13 - isDriverOnline returns true when both DB and Redis confirm', async () => {
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: true });
    mockRedisExists.mockResolvedValue(true);

    const result = await driverPresenceService.isDriverOnline(DRIVER_ID);
    expect(result).toBe(true);
  });

  test('4.14 - isDriverOnline returns false when DB says offline', async () => {
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: false });
    mockRedisExists.mockResolvedValue(true);

    const result = await driverPresenceService.isDriverOnline(DRIVER_ID);
    expect(result).toBe(false);
  });

  test('4.15 - isDriverOnline returns false when Redis key expired', async () => {
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: true });
    mockRedisExists.mockResolvedValue(false);

    const result = await driverPresenceService.isDriverOnline(DRIVER_ID);
    expect(result).toBe(false);
  });

  test('4.16 - isDriverOnline returns false on error', async () => {
    mockPrismaUserFindUnique.mockRejectedValue(new Error('DB error'));

    const result = await driverPresenceService.isDriverOnline(DRIVER_ID);
    expect(result).toBe(false);
  });

  // --- areDriversOnline ---

  test('4.17 - areDriversOnline batch checks multiple drivers', async () => {
    mockPrismaUserFindMany.mockResolvedValue([
      { id: 'd1', isAvailable: true },
      { id: 'd2', isAvailable: false },
      { id: 'd3', isAvailable: true },
    ]);
    mockRedisExists
      .mockResolvedValueOnce(true)   // d1
      .mockResolvedValueOnce(false)  // d2
      .mockResolvedValueOnce(true);  // d3

    const result = await driverPresenceService.areDriversOnline(['d1', 'd2', 'd3']);

    expect(result.get('d1')).toBe(true);
    expect(result.get('d2')).toBe(false);
    expect(result.get('d3')).toBe(true);
  });

  test('4.18 - areDriversOnline returns empty map for empty input', async () => {
    const result = await driverPresenceService.areDriversOnline([]);
    expect(result.size).toBe(0);
  });

  test('4.19 - areDriversOnline falls back to individual checks on batch error', async () => {
    // Batch query fails -- both findMany AND the parallel exists calls in the try block
    // will be triggered before the catch fires. The exists calls from the try block
    // consume the first N mocks, then isDriverOnline calls consume subsequent ones.
    mockPrismaUserFindMany.mockRejectedValue(new Error('Batch query failed'));

    // The try block also fires exists calls for d1 and d2 in parallel
    // before the catch block runs, so we need mocks for both phases:
    // Phase 1 (try block - parallel exists): these may or may not resolve before
    //   the Promise.all rejects, so add them anyway
    // Phase 2 (catch block - isDriverOnline x2): each calls findUnique + exists
    mockRedisExists
      .mockResolvedValueOnce(true)   // try-block exists for d1
      .mockResolvedValueOnce(false)  // try-block exists for d2
      .mockResolvedValueOnce(true)   // catch-block isDriverOnline(d1)
      .mockResolvedValueOnce(false); // catch-block isDriverOnline(d2)

    mockPrismaUserFindUnique
      .mockResolvedValueOnce({ isAvailable: true })   // isDriverOnline(d1)
      .mockResolvedValueOnce({ isAvailable: false });  // isDriverOnline(d2)

    const result = await driverPresenceService.areDriversOnline(['d1', 'd2']);

    expect(result.get('d1')).toBe(true);
    expect(result.get('d2')).toBe(false);
  });

  // --- getOnlineDriverIds ---

  test('4.20 - getOnlineDriverIds returns verified online drivers', async () => {
    mockRedisSMembers.mockResolvedValue(['d1', 'd2', 'd3']);
    mockRedisExists
      .mockResolvedValueOnce(true)   // d1
      .mockResolvedValueOnce(false)  // d2 stale
      .mockResolvedValueOnce(true);  // d3

    const result = await driverPresenceService.getOnlineDriverIds(TRANSPORTER_ID);

    expect(result).toEqual(['d1', 'd3']);
    // d2 should be removed from set
    expect(mockRedisSRem).toHaveBeenCalledWith(
      expect.stringContaining(TRANSPORTER_ID),
      'd2'
    );
  });

  test('4.21 - getOnlineDriverIds returns empty array when no members', async () => {
    mockRedisSMembers.mockResolvedValue([]);

    const result = await driverPresenceService.getOnlineDriverIds(TRANSPORTER_ID);
    expect(result).toEqual([]);
  });

  test('4.22 - getOnlineDriverIds returns empty array on Redis error', async () => {
    mockRedisSMembers.mockRejectedValue(new Error('Redis timeout'));

    const result = await driverPresenceService.getOnlineDriverIds(TRANSPORTER_ID);
    expect(result).toEqual([]);
  });

  // --- getAvailability ---

  test('4.23 - getAvailability returns true when DB isAvailable is true', async () => {
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: true });

    const result = await driverPresenceService.getAvailability(DRIVER_ID);

    expect(result.isOnline).toBe(true);
    expect(result).toHaveProperty('lastUpdated');
  });

  test('4.24 - getAvailability returns false when DB isAvailable is false', async () => {
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: false });

    const result = await driverPresenceService.getAvailability(DRIVER_ID);
    expect(result.isOnline).toBe(false);
  });

  test('4.25 - getAvailability returns false on error (graceful degradation)', async () => {
    mockPrismaUserFindUnique.mockRejectedValue(new Error('DB error'));

    const result = await driverPresenceService.getAvailability(DRIVER_ID);
    expect(result.isOnline).toBe(false);
  });

  // --- updateAvailability (toggle spam protection) ---

  test('4.26 - updateAvailability goes online when requested', async () => {
    mockPrismaUserFindUnique
      .mockResolvedValueOnce({ isAvailable: false })  // idempotency check
      .mockResolvedValueOnce(makeDriver({ transporterId: TRANSPORTER_ID, name: 'Toggle' })); // goOnline findUnique

    const result = await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true });
    expect(result.isOnline).toBe(true);
  });

  test('4.27 - updateAvailability goes offline when requested', async () => {
    mockPrismaUserFindUnique
      .mockResolvedValueOnce({ isAvailable: true })  // idempotency check
      .mockResolvedValueOnce(makeDriver({ transporterId: TRANSPORTER_ID, name: 'Toggle' })); // goOffline findUnique

    const result = await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: false });
    expect(result.isOnline).toBe(false);
  });

  test('4.28 - updateAvailability is idempotent (skip when state unchanged)', async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce({ isAvailable: true }); // already online

    const result = await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true });

    expect(result.isOnline).toBe(true);
    // Should not have called goOnline again (only 1 prisma call for idempotency check)
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  test('4.29 - updateAvailability rejects on cooldown', async () => {
    const recentTimestamp = (Date.now() - 1000).toString(); // 1s ago
    mockRedisGet.mockResolvedValueOnce(recentTimestamp);

    await expect(
      driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true })
    ).rejects.toThrow(AppError);
  });

  test('4.30 - updateAvailability rejects on window limit exceeded', async () => {
    mockRedisGet.mockResolvedValueOnce(null); // no cooldown
    mockRedisCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetIn: 120 });

    await expect(
      driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true })
    ).rejects.toThrow('Too many toggles');
  });

  test('4.31 - updateAvailability rejects on concurrent toggle (lock held)', async () => {
    mockRedisGet.mockResolvedValueOnce(null); // no cooldown
    mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
    mockRedisAcquireLock.mockResolvedValue({ acquired: false });
    mockPrismaUserFindUnique.mockResolvedValueOnce({ isAvailable: false }); // state differs

    await expect(
      driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true })
    ).rejects.toThrow('Toggle already in progress');
  });

  test('4.32 - updateAvailability releases lock even on error', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockRedisCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 });
    mockRedisAcquireLock.mockResolvedValue({ acquired: true });
    mockPrismaUserFindUnique.mockResolvedValueOnce({ isAvailable: false }); // state differs

    // goOnline fails
    mockPrismaUserUpdate.mockRejectedValueOnce(new Error('DB write failed'));

    await expect(
      driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true })
    ).rejects.toThrow();

    expect(mockRedisReleaseLock).toHaveBeenCalled();
  });

  test('4.33 - updateAvailability sets cooldown after successful toggle', async () => {
    mockRedisGet.mockResolvedValueOnce(null); // no cooldown
    mockPrismaUserFindUnique
      .mockResolvedValueOnce({ isAvailable: false })
      .mockResolvedValueOnce(makeDriver({ transporterId: TRANSPORTER_ID, name: 'CooldownTest' }));

    await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true });

    // Cooldown should be set after toggle
    const cooldownCalls = mockRedisSet.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('toggle:cooldown')
    );
    expect(cooldownCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('4.34 - updateAvailability gracefully degrades when rate limit check fails', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis unavailable'));
    mockRedisCheckRateLimit.mockRejectedValue(new Error('Redis unavailable'));
    mockPrismaUserFindUnique
      .mockResolvedValueOnce({ isAvailable: false })
      .mockResolvedValueOnce(makeDriver({ transporterId: TRANSPORTER_ID, name: 'GracefulDeg' }));
    mockRedisAcquireLock.mockRejectedValue(new Error('Redis unavailable'));

    // Should still proceed without protection
    const result = await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true });
    expect(result.isOnline).toBe(true);
  });
});

// =============================================================================
// SECTION 5: EDGE CASES & STRESS SCENARIOS
// =============================================================================

describe('Edge Cases & Stress Scenarios', () => {
  beforeEach(resetAllMocks);

  test('5.1 - rapid online/offline toggle is rate-limited', async () => {
    // First toggle: success
    mockRedisGet.mockResolvedValueOnce(null); // no cooldown
    mockPrismaUserFindUnique
      .mockResolvedValueOnce({ isAvailable: false })
      .mockResolvedValueOnce(makeDriver({ transporterId: TRANSPORTER_ID, name: 'Rapid' }));

    await driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: true });

    // Second toggle: cooldown active
    const recentTimestamp = Date.now().toString();
    mockRedisGet.mockResolvedValueOnce(recentTimestamp);

    await expect(
      driverPresenceService.updateAvailability(DRIVER_ID, { isOnline: false })
    ).rejects.toThrow(AppError);
  });

  test('5.2 - concurrent heartbeats from same driver are handled safely', async () => {
    mockRedisExists.mockResolvedValue(true);

    // Simulate 5 concurrent heartbeats
    const heartbeats = Array.from({ length: 5 }, () =>
      driverPresenceService.handleHeartbeat(DRIVER_ID, { lat: 12.97, lng: 77.59 })
    );

    await Promise.all(heartbeats);

    // All should have succeeded (5 set calls)
    expect(mockRedisSet).toHaveBeenCalledTimes(5);
  });

  test('5.3 - dashboard query when DB returns slowly', async () => {
    // Simulate slow DB response
    mockGetBookingsByDriver.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([]), 50))
    );
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisExists.mockResolvedValue(false);
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: false });

    const start = Date.now();
    const result = await driverPerformanceService.getDashboard(DRIVER_ID);
    const elapsed = Date.now() - start;

    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(5000); // Should complete reasonably
  });

  test('5.4 - performance metrics with zero division edge case (all declined)', async () => {
    // All assignments declined
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(5)  // total
      .mockResolvedValueOnce(0)  // completed
      .mockResolvedValueOnce(5)  // declined
      .mockResolvedValueOnce(0); // cancelled

    mockPrismaAssignmentFindMany.mockResolvedValue([]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    // acceptanceRate = (5-5)/5 * 100 = 0
    expect(result.acceptanceRate).toBe(0);
    // completionRate: accepted = 5-5 = 0, so 100% (benefit of the doubt)
    expect(result.completionRate).toBe(100);
  });

  test('5.5 - earnings calculation with zero-amount bookings', async () => {
    const recentDate = new Date().toISOString();
    const bookings = [
      makeBooking({ status: 'completed', totalAmount: 0, updatedAt: recentDate }),
      makeBooking({ status: 'completed', totalAmount: 0, updatedAt: recentDate }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getEarnings(DRIVER_ID, 'week');

    expect(result.totalEarnings).toBe(0);
    expect(result.averagePerTrip).toBe(0);
    expect(result.totalTrips).toBe(2);
  });

  test('5.6 - driver goes offline mid-trip (goOffline succeeds regardless)', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ transporterId: TRANSPORTER_ID, name: 'MidTrip' })
    );

    const result = await driverPresenceService.goOffline(DRIVER_ID);
    expect(result.isOnline).toBe(false);
  });

  test('5.7 - profile completion with partial data', async () => {
    const partialDriver = makeDriver({
      isProfileCompleted: true,
      licenseNumber: 'DL-PARTIAL',
    });
    mockUpdateUser.mockResolvedValue(partialDriver);

    const result = await driverManagementService.completeProfile(DRIVER_ID, {
      licenseNumber: 'DL-PARTIAL',
      vehicleType: '',
      address: '',
      language: 'en',
      driverPhotoUrl: '',
      licenseFrontUrl: '',
      licenseBackUrl: '',
      isProfileCompleted: true,
    });

    expect(result.isProfileCompleted).toBe(true);
  });

  test('5.8 - large fleet: getTransporterDrivers with 500 drivers', async () => {
    const drivers = Array.from({ length: 500 }, (_, i) =>
      makeDriver({ id: `driver-${i}`, isActive: i < 450 }) // 450 active, 50 inactive
    );
    const vehicles = Array.from({ length: 50 }, (_, i) =>
      makeVehicle({ status: 'in_transit', assignedDriverId: `driver-${i}` })
    );
    mockGetDriversByTransporter.mockResolvedValue(drivers);
    mockGetVehiclesByTransporter.mockResolvedValue(vehicles);

    const result = await driverManagementService.getTransporterDrivers(TRANSPORTER_ID);

    expect(result.total).toBe(450);
    expect(result.onTrip).toBe(50);
    expect(result.available).toBe(400);
  });

  test('5.9 - getActiveTrip with no pickup/drop address', async () => {
    mockGetBookingsByDriver.mockResolvedValue([
      makeBooking({
        status: 'active',
        pickup: { latitude: 12.97, longitude: 77.59 },
        drop: { latitude: 13.03, longitude: 77.63 },
      }),
    ]);

    const result = await driverPerformanceService.getActiveTrip(DRIVER_ID);

    expect(result).not.toBeNull();
    // pickup/drop address may be undefined, should not crash
    expect(result!.pickup).toBeDefined();
    expect(result!.dropoff).toBeDefined();
  });

  test('5.10 - getTrips sorts by createdAt descending', async () => {
    const bookings = [
      makeBooking({ id: 'old', createdAt: '2026-01-01T00:00:00Z' }),
      makeBooking({ id: 'new', createdAt: '2026-04-01T00:00:00Z' }),
      makeBooking({ id: 'mid', createdAt: '2026-02-15T00:00:00Z' }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getTrips(DRIVER_ID, {
      limit: 10, offset: 0,
    });

    expect(result.trips[0].id).toBe('new');
    expect(result.trips[2].id).toBe('old');
  });

  test('5.11 - on-time calculation with zero/negative distance is treated as on-time', async () => {
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    mockPrismaAssignmentFindMany.mockResolvedValue([
      {
        bookingId: 'b1', orderId: null,
        startedAt: new Date('2026-04-01T10:00:00Z'),
        completedAt: new Date('2026-04-01T15:00:00Z'),
      },
    ]);
    mockPrismaBookingFindMany.mockResolvedValue([
      { id: 'b1', distanceKm: 0 }, // zero distance
    ]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    // Zero distance => treated as on-time
    expect(result.onTimeDeliveryRate).toBe(100);
  });

  test('5.12 - on-time calculation with invalid timestamps (endMs <= startMs)', async () => {
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    mockPrismaAssignmentFindMany.mockResolvedValue([
      {
        bookingId: 'b1', orderId: null,
        startedAt: new Date('2026-04-01T15:00:00Z'),
        completedAt: new Date('2026-04-01T10:00:00Z'), // end before start
      },
    ]);
    mockPrismaBookingFindMany.mockResolvedValue([{ id: 'b1', distanceKm: 50 }]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);

    // Invalid timestamp => treated as on-time
    expect(result.onTimeDeliveryRate).toBe(100);
  });

  test('5.13 - createDriver with licensePhoto in data', async () => {
    const newDriver = makeDriver({ licensePhoto: 'base64-data' });
    mockCreateUser.mockResolvedValue(newDriver);
    mockGetDriversByTransporter.mockResolvedValue([newDriver]);
    mockGetVehiclesByTransporter.mockResolvedValue([]);

    await driverManagementService.createDriver(TRANSPORTER_ID, {
      phone: '8888888888',
      name: 'Photo Driver',
      licenseNumber: 'DL-PHOTO',
      licensePhoto: 'base64-data',
    } as any);

    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ licensePhoto: 'base64-data' })
    );
  });

  test('5.14 - getDriverById propagates non-not-found errors', async () => {
    mockGetUserById.mockRejectedValue(new Error('Connection refused'));

    await expect(
      driverManagementService.getDriverById(DRIVER_ID)
    ).rejects.toThrow('Connection refused');
  });

  test('5.15 - updateLicensePhotos with neither front nor back sends empty update', async () => {
    const driver = makeDriver();
    mockUpdateUser.mockResolvedValue(driver);

    const result = await driverManagementService.updateLicensePhotos(DRIVER_ID);

    expect(mockUpdateUser).toHaveBeenCalledWith(DRIVER_ID, {});
    expect(result).toBeDefined();
  });

  test('5.16 - getPerformance re-throws AppError without wrapping', async () => {
    const appError = new AppError(400, 'VALIDATION_ERROR', 'Bad request');
    mockPrismaAssignmentCount.mockRejectedValue(appError);

    try {
      await driverPerformanceService.getPerformance(DRIVER_ID);
      fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBe(appError);
      expect(err.statusCode).toBe(400);
    }
  });

  test('5.17 - restorePresence with driver who has no transporter', async () => {
    mockPrismaUserFindUnique.mockResolvedValue(
      makeDriver({ isAvailable: true, transporterId: null })
    );

    const result = await driverPresenceService.restorePresence(DRIVER_ID);
    expect(result).toBe(false);
  });

  test('5.18 - getOnlineDriverIds cleans stale entries from Redis SET', async () => {
    mockRedisSMembers.mockResolvedValue(['d1', 'd2']);
    // d1 exists, d2 does not
    mockRedisExists
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await driverPresenceService.getOnlineDriverIds(TRANSPORTER_ID);

    // d2 should be removed from SET
    expect(mockRedisSRem).toHaveBeenCalledTimes(1);
    expect(mockRedisSRem).toHaveBeenCalledWith(
      expect.stringContaining(TRANSPORTER_ID),
      'd2'
    );
  });

  test('5.19 - getDashboard availability uses isDriverOnline', async () => {
    const bookings = [makeBooking({ status: 'completed' })];
    mockGetBookingsByDriver.mockResolvedValue(bookings);
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);

    // Make isDriverOnline return true (both DB and Redis)
    mockPrismaUserFindUnique.mockResolvedValue({ isAvailable: true });
    mockRedisExists.mockResolvedValue(true);

    const result = await driverPerformanceService.getDashboard(DRIVER_ID);
    expect(result.availability.isOnline).toBe(true);
  });

  test('5.20 - earnings breakdown groups by date correctly', async () => {
    const now = new Date();
    const bookings = [
      makeBooking({ status: 'completed', totalAmount: 1000, updatedAt: now.toISOString(), createdAt: now.toISOString() }),
      makeBooking({ status: 'completed', totalAmount: 2000, updatedAt: now.toISOString(), createdAt: now.toISOString() }),
    ];
    mockGetBookingsByDriver.mockResolvedValue(bookings);

    const result = await driverPerformanceService.getEarnings(DRIVER_ID, 'week');

    // Both bookings on same day should be grouped
    expect(result.breakdown.length).toBe(1);
    expect(result.breakdown[0].earnings).toBe(3000);
    expect(result.breakdown[0].trips).toBe(2);
  });

  test('5.21 - on-time calculation with orders (not bookings)', async () => {
    mockPrismaAssignmentCount
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    mockPrismaAssignmentFindMany.mockResolvedValue([
      {
        bookingId: null,
        orderId: 'order-1',
        startedAt: new Date('2026-04-01T10:00:00Z'),
        completedAt: new Date('2026-04-01T10:30:00Z'),
      },
    ]);
    mockPrismaBookingFindMany.mockResolvedValue([]);
    mockPrismaOrderFindMany.mockResolvedValue([{ id: 'order-1', distanceKm: 5 }]);

    const result = await driverPerformanceService.getPerformance(DRIVER_ID);
    expect(result.totalDistance).toBeGreaterThanOrEqual(0);
  });

  test('5.22 - rating is cached in Redis on first calculation', async () => {
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(null); // no cached rating
    mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: 4.5 }, _count: { stars: 10 } });

    await driverPerformanceService.getPerformance(DRIVER_ID);

    // Should cache the rating
    const ratingSetCalls = mockRedisSet.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('driver:rating:')
    );
    expect(ratingSetCalls.length).toBe(1);
    expect(ratingSetCalls[0][2]).toBe(300); // 5min TTL
  });

  test('5.23 - rating with zero count is NOT cached', async () => {
    mockPrismaAssignmentCount.mockResolvedValue(0);
    mockPrismaAssignmentFindMany.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(null);
    mockPrismaRatingAggregate.mockResolvedValue({ _avg: { stars: null }, _count: { stars: 0 } });

    await driverPerformanceService.getPerformance(DRIVER_ID);

    const ratingSetCalls = mockRedisSet.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('driver:rating:')
    );
    expect(ratingSetCalls.length).toBe(0);
  });
});
