/**
 * =============================================================================
 * F-A-27 — PRICE_STALE 409 (FF_REJECT_STALE_PRICE_409)
 * =============================================================================
 *
 * Verifies that the fallback price-validation path in
 * `validateAndCorrectPrices` (order-creation.service.ts:444-467) does NOT
 * silently overwrite the client price with a divergent server price.
 * Instead, when the new feature flag FF_REJECT_STALE_PRICE_409 is ON, the
 * server throws AppError(409, 'PRICE_STALE') and includes a fresh quote
 * token + surge bucket end so the client can re-quote.
 *
 * When the flag is OFF (default), the legacy silent-overwrite behavior
 * MUST be preserved byte-for-byte to prevent client breakage. The flag
 * stays OFF in production until Android F-A-26 DAU rollout reaches >=90%.
 * =============================================================================
 */

// Mocks must come before the implementation imports.
jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: { incrementCounter: jest.fn(), recordHistogram: jest.fn() },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: false }, isProduction: false },
}));

jest.mock('../shared/database/db', () => ({ db: {} }));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {},
  withDbTimeout: (fn: any) => fn,
  OrderStatus: {},
  BookingStatus: {},
  TruckRequestStatus: {},
}));

jest.mock('../shared/services/redis.service', () => ({ redisService: {} }));

jest.mock('../shared/services/google-maps.service', () => ({
  googleMapsService: { calculateRoute: jest.fn() },
}));

jest.mock('../shared/utils/geo.utils', () => ({
  roundCoord: (c: number) => Math.round(c * 100) / 100,
}));

const mockCalculateEstimate = jest.fn();
const mockVerifyQuoteToken = jest.fn();

jest.mock('../modules/pricing/pricing.service', () => ({
  pricingService: { calculateEstimate: (...args: any[]) => mockCalculateEstimate(...args) },
  verifyQuoteToken: (...args: any[]) => mockVerifyQuoteToken(...args),
  signQuoteToken: jest.fn().mockReturnValue('mock-fresh-token'),
}));

import { AppError } from '../shared/types/error.types';
import { validateAndCorrectPrices } from '../modules/order/order-creation.service';
import type { OrderCreateContext } from '../modules/order/order-create-context';
import type { CreateOrderRequest } from '../modules/order/order-core-types';

function makeBaseRequest(overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest {
  return {
    customerId: 'cust-stale-1',
    customerName: 'Stale Test',
    customerPhone: '9876543210',
    routePoints: [
      { type: 'PICKUP', latitude: 12.97, longitude: 77.59, address: 'Pickup' },
      { type: 'DROP', latitude: 13.01, longitude: 77.65, address: 'Drop' },
    ],
    distanceKm: 50,
    vehicleRequirements: [
      { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 4500 },
    ],
    cargoWeightKg: 20000,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<OrderCreateContext> = {}): OrderCreateContext {
  return {
    request: makeBaseRequest(),
    backpressureKey: '',
    maxConcurrentOrders: 200,
    requestPayloadHash: '',
    lockKey: '',
    lockAcquired: false,
    dedupeKey: '',
    idempotencyHash: '',
    distanceSource: 'client_fallback',
    clientDistanceKm: 50,
    totalAmount: 0,
    totalTrucks: 0,
    routePoints: [],
    pickup: { latitude: 0, longitude: 0, address: '' },
    drop: { latitude: 0, longitude: 0, address: '' },
    orderId: 'order-stale-uuid',
    expiresAt: '',
    truckRequests: [],
    responseRequests: [],
    dispatchState: 'dispatching',
    dispatchReasonCode: undefined,
    dispatchAttempts: 1,
    onlineCandidates: 0,
    notifiedTransporters: 0,
    orderResponse: null,
    earlyReturn: null,
    ...overrides,
  };
}

describe('F-A-27 — PRICE_STALE 409 fallback path', () => {
  const ORIGINAL_FF = process.env.FF_REJECT_STALE_PRICE_409;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyQuoteToken.mockReturnValue(false); // force fallback path
  });

  afterEach(() => {
    if (ORIGINAL_FF === undefined) {
      delete process.env.FF_REJECT_STALE_PRICE_409;
    } else {
      process.env.FF_REJECT_STALE_PRICE_409 = ORIGINAL_FF;
    }
  });

  // ==========================================================================
  // FLAG ON: must throw 409 PRICE_STALE
  // ==========================================================================
  describe('when FF_REJECT_STALE_PRICE_409 = "true"', () => {
    beforeEach(() => {
      process.env.FF_REJECT_STALE_PRICE_409 = 'true';
    });

    it('throws AppError(409, PRICE_STALE) when no quoteToken AND client price diverges >5% low', () => {
      // Server says 6000, client sent 4500 -> -25% (below -5% tolerance).
      mockCalculateEstimate.mockReturnValue({
        pricePerTruck: 6000,
        surgeRuleId: 'rule-fresh',
        surgeBucketStart: '2026-04-18T10:00:00.000Z',
        surgeBucketEnd: '2026-04-18T10:05:00.000Z',
        quoteToken: 'fresh-token-xyz',
      });
      const ctx = makeCtx();

      let thrown: unknown;
      try {
        validateAndCorrectPrices(ctx);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AppError);
      const e = thrown as AppError;
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('PRICE_STALE');
      expect(e.message).toMatch(/Price has changed/i);
      expect(e.details).toMatchObject({
        clientPrice: 4500,
        serverPrice: 6000,
        freshQuoteToken: 'fresh-token-xyz',
        surgeBucketEnd: '2026-04-18T10:05:00.000Z',
      });
      // Client price MUST NOT be silently overwritten when the flag is ON.
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(4500);
    });

    it('does NOT throw when client price is within tolerance', () => {
      // Server 5000 vs client 4900 -> -2%, within ±5%.
      mockCalculateEstimate.mockReturnValue({
        pricePerTruck: 5000,
        surgeRuleId: 'rule-ok',
        surgeBucketStart: '2026-04-18T10:00:00.000Z',
        surgeBucketEnd: '2026-04-18T10:05:00.000Z',
        quoteToken: 't',
      });
      const ctx = makeCtx({
        request: makeBaseRequest({
          vehicleRequirements: [
            { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 4900 },
          ],
        }),
      });

      expect(() => validateAndCorrectPrices(ctx)).not.toThrow();
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(4900);
    });
  });

  // ==========================================================================
  // FLAG OFF: legacy silent-overwrite preserved (no client breakage)
  // ==========================================================================
  describe('when FF_REJECT_STALE_PRICE_409 unset (legacy default)', () => {
    beforeEach(() => {
      delete process.env.FF_REJECT_STALE_PRICE_409;
    });

    it('silently overwrites pricePerTruck with serverPrice (legacy behavior)', () => {
      mockCalculateEstimate.mockReturnValue({
        pricePerTruck: 6000,
        surgeRuleId: 'rule-x',
        surgeBucketStart: '2026-04-18T10:00:00.000Z',
        surgeBucketEnd: '2026-04-18T10:05:00.000Z',
        quoteToken: 't',
      });
      const ctx = makeCtx();

      expect(() => validateAndCorrectPrices(ctx)).not.toThrow();
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(6000);
      expect(ctx.totalAmount).toBe(6000);
    });
  });

  describe('when FF_REJECT_STALE_PRICE_409 = "false"', () => {
    beforeEach(() => {
      process.env.FF_REJECT_STALE_PRICE_409 = 'false';
    });

    it('still preserves legacy silent-overwrite (explicit OFF)', () => {
      mockCalculateEstimate.mockReturnValue({
        pricePerTruck: 6000,
        surgeRuleId: 'rule-x',
        surgeBucketStart: '2026-04-18T10:00:00.000Z',
        surgeBucketEnd: '2026-04-18T10:05:00.000Z',
        quoteToken: 't',
      });
      const ctx = makeCtx();

      expect(() => validateAndCorrectPrices(ctx)).not.toThrow();
      expect(ctx.request.vehicleRequirements[0].pricePerTruck).toBe(6000);
    });
  });
});
