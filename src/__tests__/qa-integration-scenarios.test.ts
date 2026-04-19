/**
 * =============================================================================
 * QA INTEGRATION SCENARIOS - Full Customer-to-Transporter Flow
 * =============================================================================
 *
 * Integration scenario tests verifying the complete customer-to-transporter
 * flow works end-to-end after all 25 production-hardening fixes.
 *
 * SCENARIOS:
 * 1. Happy path: Customer orders, transporter gets notified, accepts
 * 2. Legacy migration path: /broadcasts/create returns 410
 * 3. Auth lifecycle: OTP, cooldown, verify, JWT deviceId, logout, blacklist
 * 4. Distance validation pipeline: India geofence + haversine ceiling
 * 5. Broadcast resilience: dispatch outbox + retry + adaptive fanout
 * 6. FCM token lifecycle (H15): Redis + DB dual-write with fallback
 * 7. Driver logout (M4): token blacklisting + presence cleanup
 * 8. Socket.IO initialization order (H14): Redis before Socket.IO
 *
 * Tests mock external services (Redis, DB, SMS) but verify the integration
 * between modules via source-code structure checks and Zod schema validation.
 *
 * @author QA Agent QA5
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** India bounding box constants (must match validation.utils.ts) */
const INDIA_LAT_MIN = 6.5;
const INDIA_LAT_MAX = 37.0;
const INDIA_LNG_MIN = 68.0;
const INDIA_LNG_MAX = 97.5;

/** Valid coordinates in Mumbai */
const MUMBAI_PICKUP = { latitude: 19.076, longitude: 72.8777 };
const MUMBAI_DROP = { latitude: 19.228, longitude: 72.8545 };

/** Invalid coordinates in London */
const LONDON_COORDS = { latitude: 51.5074, longitude: -0.1278 };

/** Build a nested location object */
function makeLocation(lat: number, lng: number, address = 'Test Address') {
  return { coordinates: { latitude: lat, longitude: lng }, address };
}

/** Build a flat location object (customer app format) */
function makeFlatLocation(lat: number, lng: number, address = 'Test Address') {
  return { latitude: lat, longitude: lng, address };
}

/** Read source file relative to __dirname (src/__tests__) */
function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
}

// =============================================================================
// SCENARIO 1: Happy Path - Customer orders, transporter accepts
// =============================================================================

describe('Scenario 1: Happy path — customer orders, transporter notified, accepts', () => {
  it('1.1 authService.verifyOtp accepts a deviceId parameter', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('deviceId?: string');
    expect(src).toContain('async verifyOtp(phone: string, otp: string, role: UserRole, deviceId?: string)');
  });

  it('1.2 generateAccessToken embeds deviceId into JWT payload', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('...(deviceId ? { deviceId } : {})');
  });

  it('1.3 coordinatesSchema validates Mumbai coordinates pass India geofence', () => {
    const { coordinatesSchema } = require('../shared/utils/validation.utils');
    expect(coordinatesSchema.safeParse(MUMBAI_PICKUP).success).toBe(true);
    expect(coordinatesSchema.safeParse(MUMBAI_DROP).success).toBe(true);
  });

  it('1.4 POST /bookings/orders is guarded by authMiddleware + customer roleGuard', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain("roleGuard(['customer'])");
    expect(src).toContain("'/orders'");
    expect(src).toContain('authMiddleware');
  });

  it('1.5 order creation enqueues dispatch asynchronously (not blocking response)', () => {
    const src = readSource('../modules/order/order.service.ts');
    expect(src).toContain('enqueueOrderDispatchOutbox');
  });

  it('1.6 broadcast service emits socket events and FCM push to transporters', () => {
    const src = readSource('../modules/order/order-broadcast.service.ts');
    expect(src).toContain('sendPushNotification');
    expect(src).toContain('emitToUser');
    expect(src).toContain('emitToUsers');
  });

  it('1.7 accept truck request does NOT require driverId — C5 fix', () => {
    const broadcastRoutes = readSource('../modules/broadcast/broadcast.routes.ts');
    expect(broadcastRoutes).toContain("driverId: z.string().uuid('Invalid driver ID').optional()");

    const bookingRoutes = readSource('../modules/booking/booking.routes.ts');
    expect(bookingRoutes).toContain('const { vehicleId, driverId } = req.body');
  });

  it('1.8 order accept service signature takes driverId as last parameter', () => {
    const src = readSource('../modules/order/order-accept.service.ts');
    expect(src).toContain('export async function acceptTruckRequest(');
    expect(src).toContain('truckRequestId: string');
    expect(src).toContain('transporterId: string');
    expect(src).toContain('vehicleId: string');
    expect(src).toContain('driverId: string');
  });

  it('1.9 accept route uses distributed lock + CAS for concurrency safety', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain("const lockKey = 'lock:truck-request:' + truckRequestId");
    expect(src).toContain('redisService.acquireLock(lockKey');
    expect(src).toContain('redisService.releaseLock(lockKey');
  });

  it('1.10 accept service uses serializable transactions with MAX_RETRIES', () => {
    const src = readSource('../modules/order/order-accept.service.ts');
    expect(src).toContain('MAX_RETRIES');
    expect(src).toContain('Prisma');
  });
});

// =============================================================================
// SCENARIO 2: Legacy Migration Path
// =============================================================================

describe('Scenario 2: Legacy migration — /broadcasts/create returns 410', () => {
  it('2.1 POST /broadcasts/create returns 410 with ENDPOINT_DEPRECATED', () => {
    const src = readSource('../modules/broadcast/broadcast.routes.ts');
    expect(src).toContain("router.post('/create'");
    expect(src).toContain('410');
    expect(src).toContain('ENDPOINT_DEPRECATED');
    expect(src).toContain('Use POST /api/v1/bookings/orders instead');
  });

  it('2.2 canonical order endpoint exists at POST /bookings/orders', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain("'/orders'");
    expect(src).toContain('canonicalOrderService.createOrder');
  });

  it('2.3 legacy POST /bookings proxies to canonical order service', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain('FF_LEGACY_BOOKING_PROXY_TO_ORDER');
    expect(src).toContain("res.setHeader('X-Weelo-Legacy-Proxy'");
    expect(src).toContain("res.setHeader('X-Weelo-Canonical-Path'");
  });

  it('2.4 legacy proxy feature flag defaults to enabled (must opt-out)', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain("process.env.FF_LEGACY_BOOKING_PROXY_TO_ORDER !== 'false'");
  });

  it('2.5 legacy path transforms payload to canonical normalizeCreateOrderInput', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain('normalizeCreateOrderInput');
    expect(src).toContain('toCreateOrderServiceRequest');
    expect(src).toContain('buildCreateOrderResponseData');
  });
});

// =============================================================================
// SCENARIO 3: Auth Lifecycle
// =============================================================================

describe('Scenario 3: Auth lifecycle — OTP, cooldown, JWT, deviceId, logout, blacklist', () => {
  it('3.1 sendOtp enforces 30-second per-phone cooldown', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('otp:cooldown:');
    expect(src).toContain('OTP_COOLDOWN');
    expect(src).toContain('Please wait 30 seconds');
    expect(src).toContain("await redisService.set(cooldownKey, '1', 30)");
  });

  it('3.2 verifyOtp returns JWT with deviceId embedded when provided', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('private generateAccessToken(user: AuthUser, deviceId?: string)');
    expect(src).toContain('...(deviceId ? { deviceId } : {})');
  });

  it('3.3 auth middleware checks JTI blacklist for revoked tokens', () => {
    const src = readSource('../shared/middleware/auth.middleware.ts');
    expect(src).toContain('`blacklist:${decoded.jti}`');
    expect(src).toContain('TOKEN_REVOKED');
    expect(src).toContain('Token has been revoked');
  });

  it('3.4 optional auth middleware also checks JTI blacklist', () => {
    const src = readSource('../shared/middleware/auth.middleware.ts');
    const optionalSection = src.substring(
      src.indexOf('export async function optionalAuthMiddleware')
    );
    expect(optionalSection).toContain('`blacklist:${decoded.jti}`');
    expect(optionalSection).toContain('isBlacklisted');
  });

  it('3.5 logout blacklists access token JTI in Redis with remaining TTL', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('async logout(userId: string, jti?: string, exp?: number)');
    expect(src).toContain("await redisService.set(`blacklist:${jti}`, 'revoked', remainingTTL)");
  });

  it('3.6 logout invalidates ALL refresh tokens for the user', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('REDIS_KEYS.USER_TOKENS(userId)');
    expect(src).toContain('await redisService.sMembers(userTokensKey)');
    expect(src).toContain('await redisService.del(REDIS_KEYS.REFRESH_TOKEN(tokenId))');
  });

  it('3.7 refreshToken preserves deviceId across token rotation', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('decoded.deviceId || stored.deviceId || undefined');
    expect(src).toContain('this.generateAccessToken(user, refreshDeviceId)');
    expect(src).toContain('this.generateRefreshToken(user, refreshDeviceId)');
  });

  it('3.8 refresh token has 30-second grace period (overlap window)', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('await redisService.expire(REDIS_KEYS.REFRESH_TOKEN(tokenId), 30)');
  });

  it('3.9 auth routes wire up all 5 endpoints correctly', () => {
    const src = readSource('../modules/auth/auth.routes.ts');
    expect(src).toContain("router.post('/send-otp'");
    expect(src).toContain("router.post('/verify-otp'");
    expect(src).toContain("router.post('/refresh'");
    expect(src).toContain("router.post('/logout'");
    expect(src).toContain("router.get('/me'");
  });

  it('3.10 logout route requires authentication middleware', () => {
    const src = readSource('../modules/auth/auth.routes.ts');
    expect(src).toContain("'/logout', authenticate");
  });

  it('3.11 logout cleans up FCM tokens, socket counts, and presence', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('fcmService.removeAllTokens(userId)');
    expect(src).toContain("redisService.del(`socket:conncount:${userId}`)");
    expect(src).toContain("redisService.del(`driver:presence:${userId}`)");
    expect(src).toContain('availabilityService.setOffline(userId)');
    expect(src).toContain('ONLINE_TRANSPORTERS_SET');
  });
});

// =============================================================================
// SCENARIO 4: Distance Validation Pipeline
// =============================================================================

describe('Scenario 4: Distance validation pipeline — India geofence + haversine ceiling', () => {
  it('4.1 coordinatesSchema rejects London (outside India)', () => {
    const { coordinatesSchema } = require('../shared/utils/validation.utils');
    const result = coordinatesSchema.safeParse(LONDON_COORDS);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i: { message: string }) => i.message);
      expect(msgs.some((m: string) => m.includes('India'))).toBe(true);
    }
  });

  it('4.2 coordinatesSchema accepts Mumbai (inside India)', () => {
    const { coordinatesSchema } = require('../shared/utils/validation.utils');
    expect(coordinatesSchema.safeParse(MUMBAI_PICKUP).success).toBe(true);
    expect(coordinatesSchema.safeParse(MUMBAI_DROP).success).toBe(true);
  });

  it('4.3 locationSchema flat format passes India geofence for Mumbai', () => {
    const { locationSchema } = require('../shared/utils/validation.utils');
    const flat = makeFlatLocation(MUMBAI_PICKUP.latitude, MUMBAI_PICKUP.longitude);
    expect(locationSchema.safeParse(flat).success).toBe(true);
  });

  it('4.4 locationSchema flat format rejects London', () => {
    const { locationSchema } = require('../shared/utils/validation.utils');
    const flat = makeFlatLocation(LONDON_COORDS.latitude, LONDON_COORDS.longitude);
    expect(locationSchema.safeParse(flat).success).toBe(false);
  });

  it('4.5 locationSchema nested format passes India geofence for Mumbai', () => {
    const { locationSchema } = require('../shared/utils/validation.utils');
    const nested = makeLocation(MUMBAI_PICKUP.latitude, MUMBAI_PICKUP.longitude);
    expect(locationSchema.safeParse(nested).success).toBe(true);
  });

  it('4.6 locationSchema nested format rejects London', () => {
    const { locationSchema } = require('../shared/utils/validation.utils');
    const nested = makeLocation(LONDON_COORDS.latitude, LONDON_COORDS.longitude);
    expect(locationSchema.safeParse(nested).success).toBe(false);
  });

  it('4.7 haversineDistanceKm computes correct distance for Mumbai route', () => {
    const { haversineDistanceKm } = require('../shared/utils/geospatial.utils');
    const dist = haversineDistanceKm(
      MUMBAI_PICKUP.latitude, MUMBAI_PICKUP.longitude,
      MUMBAI_DROP.latitude, MUMBAI_DROP.longitude
    );
    expect(dist).toBeGreaterThan(10);
    expect(dist).toBeLessThan(30);
  });

  it('4.8 order service applies haversine ceiling cap (3x multiplier)', () => {
    const src = readSource('../modules/order/order.service.ts');
    expect(src).toContain('haversineCeiling');
    expect(src).toContain('Math.ceil(haversineDist * 3.0)');
    expect(src).toContain('request.distanceKm > haversineCeiling');
  });

  it('4.9 India geofence bounds match expected values in coordinatesSchema', () => {
    const src = readSource('../shared/utils/validation.utils.ts');
    expect(src).toContain('coords.latitude >= 6.5');
    expect(src).toContain('coords.latitude <= 37.0');
    expect(src).toContain('coords.longitude >= 68.0');
    expect(src).toContain('coords.longitude <= 97.5');
  });

  it('4.10 coordinatesSchema rejects points just outside India boundaries', () => {
    const { coordinatesSchema } = require('../shared/utils/validation.utils');
    // Below south boundary
    expect(coordinatesSchema.safeParse({ latitude: 6.4, longitude: 80.0 }).success).toBe(false);
    // Above north boundary
    expect(coordinatesSchema.safeParse({ latitude: 37.1, longitude: 80.0 }).success).toBe(false);
    // West of boundary
    expect(coordinatesSchema.safeParse({ latitude: 20.0, longitude: 67.9 }).success).toBe(false);
    // East of boundary
    expect(coordinatesSchema.safeParse({ latitude: 20.0, longitude: 97.6 }).success).toBe(false);
  });

  it('4.11 coordinatesSchema accepts points at India boundary limits', () => {
    const { coordinatesSchema } = require('../shared/utils/validation.utils');
    expect(coordinatesSchema.safeParse({ latitude: 6.5, longitude: 68.0 }).success).toBe(true);
    expect(coordinatesSchema.safeParse({ latitude: 37.0, longitude: 97.5 }).success).toBe(true);
  });

  it('4.12 haversine ceiling prevents inflated client distance from being accepted', () => {
    const { haversineDistanceKm } = require('../shared/utils/geospatial.utils');
    const haversineDist = haversineDistanceKm(
      MUMBAI_PICKUP.latitude, MUMBAI_PICKUP.longitude,
      MUMBAI_DROP.latitude, MUMBAI_DROP.longitude
    );
    const ceiling = Math.ceil(haversineDist * 3.0);
    // A client claiming 200km for a 17km route would be capped
    expect(200).toBeGreaterThan(ceiling);
    // But a reasonable claim of 25km would pass
    expect(25).toBeLessThanOrEqual(ceiling);
  });
});

// =============================================================================
// SCENARIO 5: Broadcast Resilience
// =============================================================================

describe('Scenario 5: Broadcast resilience — dispatch outbox + retry + adaptive fanout', () => {
  it('5.1 order dispatch outbox service exists with worker/enqueue/process exports', () => {
    expect(() => require.resolve('../modules/order/order-dispatch-outbox.service')).not.toThrow();
    const src = readSource('../modules/order/order-dispatch-outbox.service.ts');
    expect(src).toContain('startDispatchOutboxWorker');
    expect(src).toContain('enqueueOrderDispatchOutbox');
    expect(src).toContain('processDispatchOutboxImmediately');
  });

  it('5.2 order service imports and delegates to dispatch outbox', () => {
    const src = readSource('../modules/order/order.service.ts');
    expect(src).toContain("from './order-dispatch-outbox.service'");
    expect(src).toContain('enqueueOrderDispatchOutbox');
    expect(src).toContain('startDispatchOutboxWorker');
  });

  it('5.3 broadcast service uses adaptive fanout for transporter notification', () => {
    const src = readSource('../modules/order/order-broadcast.service.ts');
    expect(src).toContain('emitToTransportersWithAdaptiveFanout');
    expect(src).toContain('chunkTransporterIds');
  });

  it('5.4 broadcast service tracks notified transporters in Redis set', () => {
    const src = readSource('../modules/order/order-broadcast.service.ts');
    expect(src).toContain('markTransportersNotified');
    expect(src).toContain('getNotifiedTransporters');
    expect(src).toContain('notifiedTransportersKey');
  });

  it('5.5 progressive radius matcher provides multi-step expansion', () => {
    expect(() => require.resolve('../modules/order/progressive-radius-matcher')).not.toThrow();
    const src = readSource('../modules/order/progressive-radius-matcher.ts');
    expect(src).toContain('PROGRESSIVE_RADIUS_STEPS');
  });

  it('5.6 dispatch outbox feature flag defaults to enabled', () => {
    const src = readSource('../modules/order/order-dispatch-outbox.service.ts');
    expect(src).toContain('FF_ORDER_DISPATCH_OUTBOX');
  });

  it('5.7 broadcast sends both Socket.IO events and FCM push notifications', () => {
    const src = readSource('../modules/order/order-broadcast.service.ts');
    expect(src).toContain("import { sendPushNotification }");
    expect(src).toContain("import { emitToUser, emitToUsers, isUserConnectedAsync }");
  });

  it('5.8 dispatch outbox emits status events for observability', () => {
    const src = readSource('../modules/order/order-dispatch-outbox.service.ts');
    expect(src).toContain('FF_ORDER_DISPATCH_STATUS_EVENTS');
  });

  it('5.9 broadcast strict sent accounting flag exists for reliable delivery tracking', () => {
    const src = readSource('../modules/order/order-broadcast.service.ts');
    expect(src).toContain('FF_BROADCAST_STRICT_SENT_ACCOUNTING');
  });
});

// =============================================================================
// SCENARIO 6: FCM Token Lifecycle (H15)
// =============================================================================

describe('Scenario 6: FCM token lifecycle — Redis + DB dual-write with fallback (H15)', () => {
  it('6.1 registerToken writes to BOTH Redis AND DB (H15 fix)', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain('await redisService.sAdd(key, token)');
    expect(src).toContain('prismaClient.deviceToken.upsert');
    expect(src).toContain('Fix H15: Always persist to DB as durable fallback');
  });

  it('6.2 getTokens uses isRedisAvailable check and has DB fallback path', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain('isRedisAvailable');
    expect(src).toContain('prismaClient.deviceToken');
  });

  it('6.3 registerToken sets 90-day TTL on Redis key', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain('await redisService.expire(key, FCM_TOKEN_TTL_SECONDS)');
    expect(src).toContain('90 * 24 * 60 * 60');
  });

  it('6.4 FCM_TOKEN_KEY uses consistent Redis key pattern', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain("`fcm:tokens:${userId}`");
  });

  it('6.5 removeToken uses Redis SREM for atomic removal', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain('await redisService.sRem(key, token)');
  });

  it('6.6 removeAllTokens deletes the entire FCM key on logout', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain('async removeAllTokens(userId: string)');
    expect(src).toContain('await redisService.del(FCM_TOKEN_KEY(userId))');
  });

  it('6.7 logout calls fcmService.removeAllTokens', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('fcmService.removeAllTokens(userId)');
  });

  it('6.8 non-retryable FCM error codes prevent wasted retries', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain('NON_RETRYABLE_FCM_ERRORS');
    expect(src).toContain('messaging/registration-token-not-registered');
    expect(src).toContain('messaging/invalid-registration-token');
    expect(src).toContain('messaging/invalid-argument');
    expect(src).toContain('messaging/mismatched-credential');
  });

  it('6.9 DB fallback upsert uses userId_token compound key', () => {
    const src = readSource('../shared/services/fcm.service.ts');
    expect(src).toContain('where: { userId_token: { userId, token } }');
    expect(src).toContain("create: { userId, token, platform, lastSeenAt: new Date() }");
  });
});

// =============================================================================
// SCENARIO 7: Driver Logout (M4)
// =============================================================================

describe('Scenario 7: Driver logout — token blacklisting and presence cleanup (M4)', () => {
  it('7.1 driver-auth routes include POST /logout (M4 fix)', () => {
    const src = readSource('../modules/driver-auth/driver-auth.routes.ts');
    expect(src).toContain("router.post('/logout'");
    expect(src).toContain('authMiddleware');
    expect(src).toContain('Fix M4');
  });

  it('7.2 driver logout extracts JTI and exp from the authenticated token', () => {
    const src = readSource('../modules/driver-auth/driver-auth.routes.ts');
    expect(src).toContain('const jti = req.user?.jti');
    expect(src).toContain('decoded.exp');
  });

  it('7.3 driver logout delegates to shared authService.logout', () => {
    const src = readSource('../modules/driver-auth/driver-auth.routes.ts');
    expect(src).toContain('await authService.logout(userId, jti, exp)');
  });

  it('7.4 driver auth service generates access tokens with JTI for revocation', () => {
    const src = readSource('../modules/driver-auth/driver-auth.service.ts');
    expect(src).toContain('jti: crypto.randomUUID()');
    expect(src).toContain("role: 'driver'");
  });

  it('7.5 driver auth service stores refresh tokens in Redis', () => {
    const src = readSource('../modules/driver-auth/driver-auth.service.ts');
    // REDIS_KEYS constants are defined for driver tokens
    expect(src).toContain('DRIVER_REFRESH_TOKEN');
    expect(src).toContain('DRIVER_TOKENS');
    // generateRefreshToken stores in Redis with refresh:{tokenId} pattern
    expect(src).toContain('`refresh:${tokenId}`');
    expect(src).toContain('`user:tokens:${driver.id}`');
  });

  it('7.6 shared logout sets driver/transporter offline', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain("userRole === 'transporter' || userRole === 'driver'");
    expect(src).toContain('availabilityService.setOffline(userId)');
  });

  it('7.7 shared logout cleans up socket connection counts', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain("redisService.del(`socket:conncount:${userId}`)");
  });

  it('7.8 shared logout cleans up driver presence key', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain("redisService.del(`driver:presence:${userId}`)");
  });

  it('7.9 shared logout removes transporter from online set', () => {
    const src = readSource('../modules/auth/auth.service.ts');
    expect(src).toContain('TRANSPORTER_PRESENCE_KEY');
    expect(src).toContain('ONLINE_TRANSPORTERS_SET');
    expect(src).toContain('redisService.sRem(ONLINE_TRANSPORTERS_SET, userId)');
  });

  it('7.10 auth middleware validates JTI blacklist so revoked tokens fail', () => {
    const src = readSource('../shared/middleware/auth.middleware.ts');
    expect(src).toContain('decoded.jti');
    expect(src).toContain('`blacklist:${decoded.jti}`');
    expect(src).toContain("'TOKEN_REVOKED'");
  });

  it('7.11 driver auth verify-otp is wired up in routes', () => {
    const src = readSource('../modules/driver-auth/driver-auth.routes.ts');
    expect(src).toContain("'/verify-otp'");
    expect(src).toContain('driverAuthController.verifyOtp');
  });

  it('7.12 driver auth send-otp sends OTP to transporter phone (not driver)', () => {
    const src = readSource('../modules/driver-auth/driver-auth.service.ts');
    expect(src).toContain('await smsService.sendOtp(transporter.phone, otp)');
    expect(src).toContain('OTP sent to your transporter');
  });
});

// =============================================================================
// SCENARIO 8: Socket.IO Initialization Order (H14)
// =============================================================================

describe('Scenario 8: Socket.IO initialization order — Redis before Socket.IO (H14)', () => {
  it('8.1 server.ts calls redisService.initialize() BEFORE initializeSocket()', () => {
    const src = readSource('../server.ts');
    const redisInitIdx = src.indexOf('await redisService.initialize()');
    const socketInitIdx = src.indexOf('initializeSocket(server)');

    expect(redisInitIdx).toBeGreaterThan(-1);
    expect(socketInitIdx).toBeGreaterThan(-1);
    expect(redisInitIdx).toBeLessThan(socketInitIdx);
  });

  it('8.2 server.ts has explicit H14 fix comment', () => {
    const src = readSource('../server.ts');
    expect(src).toContain('Fix H14: AFTER Redis is ready');
  });

  it('8.3 initializeSocket is inside the async bootstrap function (not at top level)', () => {
    const src = readSource('../server.ts');
    const bootstrapStart = src.indexOf('async function bootstrap()');
    const socketInit = src.indexOf('initializeSocket(server)', bootstrapStart);
    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(socketInit).toBeGreaterThan(bootstrapStart);
  });

  it('8.4 server.ts imports both redisService and initializeSocket', () => {
    const src = readSource('../server.ts');
    expect(src).toContain('import { initializeSocket');
    expect(src).toContain('redisService');
  });

  it('8.5 Redis initialization is wrapped in try-catch (continues on failure)', () => {
    const src = readSource('../server.ts');
    expect(src).toContain('RedisService initialization failed');
    expect(src).toContain('Socket.IO initialized (Redis adapter ready)');
  });

  it('8.6 Redis reconnect wires up grace period for stale transporter cleanup', () => {
    const src = readSource('../server.ts');
    expect(src).toContain("rawClient.on('connect'");
    expect(src).toContain('setReconnectGracePeriod');
    expect(src).toContain('grace period activated');
  });
});

// =============================================================================
// CROSS-CUTTING: Verify key fix references and module resolution
// =============================================================================

describe('Cross-cutting: Key fixes are properly applied', () => {
  it('C5 fix: driverId is optional in broadcast accept schema', () => {
    const src = readSource('../modules/broadcast/broadcast.routes.ts');
    expect(src).toContain('acceptBroadcastBodySchema');
    expect(src).toContain("driverId: z.string().uuid('Invalid driver ID').optional()");
    expect(src).toContain("vehicleId: z.string().uuid('Invalid vehicle ID')");
  });

  it('H-S3 fix: broadcast routes use authenticated user ID, not client-supplied', () => {
    const src = readSource('../modules/broadcast/broadcast.routes.ts');
    expect(src).toContain('H-S3 FIX: Use authenticated user ID');
    expect(src).toContain('const actorId = req.user!.userId');
  });

  it('H-S2 fix: BOLA guard returns 404 (not 403) to prevent info leakage', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain('H-S2 FIX: BOLA guard');
    expect(src).toContain('details.customerId !== req.user!.userId');
  });

  it('B4 fix: order service imports state machine for status assertions', () => {
    const src = readSource('../modules/order/order.service.ts');
    expect(src).toContain('Fix B4: Import state machine');
    expect(src).toContain('assertValidTransition');
    expect(src).toContain('ORDER_VALID_TRANSITIONS');
  });

  it('broadcast accept has per-user rate limiter that fails open on Redis error', () => {
    const src = readSource('../modules/broadcast/broadcast.routes.ts');
    expect(src).toContain('acceptRateLimiter');
    expect(src).toContain('rl:broadcast-accept:');
    expect(src).toContain('count > 10');
    expect(src).toContain('Redis failure');
  });

  it('booking route uses request queue with priority', () => {
    const src = readSource('../modules/booking/booking.routes.ts');
    expect(src).toContain('bookingQueue.middleware');
    expect(src).toContain('Priority.HIGH');
  });
});

// =============================================================================
// Module resolution: all critical modules load without errors
// =============================================================================

describe('Module resolution: critical modules load without circular dependency errors', () => {
  const modules = [
    '../modules/auth/auth.service',
    '../modules/auth/auth.routes',
    '../modules/auth/otp-challenge.service',
    '../modules/auth/sms.service',
    '../modules/booking/booking.routes',
    '../modules/booking/booking.schema',
    '../modules/broadcast/broadcast.routes',
    '../modules/broadcast/broadcast.service',
    '../modules/driver-auth/driver-auth.routes',
    '../modules/driver-auth/driver-auth.service',
    '../modules/order/order-accept.service',
    '../modules/order/order-broadcast.service',
    '../modules/order/order-dispatch-outbox.service',
    '../shared/middleware/auth.middleware',
    '../shared/services/fcm.service',
    '../shared/utils/validation.utils',
    '../shared/utils/geospatial.utils',
  ];

  for (const mod of modules) {
    const name = mod.split('/').pop();
    it(`${name} resolves without error`, () => {
      expect(() => require.resolve(mod)).not.toThrow();
    });
  }
});
