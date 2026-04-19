/**
 * =============================================================================
 * F-B-26: Durable Emit Contract Tests
 * =============================================================================
 *
 * Asserts that LIFECYCLE_EMIT_EVENTS written via the public emit helpers are
 * persisted to `socket:unacked:{userId}` under a per-user seq BEFORE the
 * socket fan-out fires, when FF_DURABLE_EMIT_ENABLED is on.
 *
 * Contract:
 *   1. emitToUser(userId, lifecycle, data) -> redisService.incr(`socket:seq:${userId}`)
 *      followed by zAdd(`socket:unacked:${userId}`, seq, envelope) + expire TTL.
 *   2. Non-lifecycle events (location_updated, broadcast_countdown) never
 *      trigger ZADD regardless of flag state.
 *   3. With FF off (default), no ZADD is called from any emit helper — the
 *      queue processor path remains the ONLY ZSET writer (pre-F-B-26 baseline).
 *
 * =============================================================================
 */

// MOCK SETUP — must come before imports
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

// Per-user seq counters for the mock. Mirrors the real Redis INCR semantics.
const mockSeqByKey = new Map<string, number>();
const mockRedisIncr = jest.fn(async (key: string) => {
  const next = (mockSeqByKey.get(key) ?? 0) + 1;
  mockSeqByKey.set(key, next);
  return next;
});
const mockRedisZAdd = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(true);
const mockRedisIncrBy = jest.fn().mockResolvedValue(1);
const mockRedisZRangeByScore = jest.fn().mockResolvedValue([]);
const mockRedisZRemRangeByScore = jest.fn().mockResolvedValue(0);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: (key: string) => mockRedisIncr(key),
    incrBy: (...args: unknown[]) => mockRedisIncrBy(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    exists: jest.fn().mockResolvedValue(false),
    sAdd: jest.fn().mockResolvedValue(1),
    sIsMember: jest.fn().mockResolvedValue(false),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    getJSON: jest.fn(),
    setJSON: jest.fn(),
    lPush: jest.fn(),
    lTrim: jest.fn(),
    zAdd: (...args: unknown[]) => mockRedisZAdd(...args),
    zRangeByScore: (...args: unknown[]) => mockRedisZRangeByScore(...args),
    zRemRangeByScore: (...args: unknown[]) => mockRedisZRemRangeByScore(...args),
    setTimer: jest.fn(),
    cancelTimer: jest.fn(),
    getExpiredTimers: jest.fn(),
    acquireLock: jest.fn(),
    releaseLock: jest.fn(),
    getClient: jest.fn().mockReturnValue(null),
    isConnected: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('../config/environment', () => ({
  config: { isDevelopment: false, jwt: { secret: 'test-secret' } },
}));

jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
}));

jest.mock('../shared/services/transporter-online.service', () => ({
  TRANSPORTER_PRESENCE_KEY: (id: string) => `transporter:presence:${id}`,
  PRESENCE_TTL_SECONDS: 60,
  ONLINE_TRANSPORTERS_SET: 'online:transporters',
}));

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('@socket.io/redis-streams-adapter', () => ({ createAdapter: jest.fn() }));

// ---------------------------------------------------------------------------
// Fake io implementation — replaces the real Socket.IO Server for tests
// ---------------------------------------------------------------------------

interface EmitRecord {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

function makeFakeIo(roomMembers: Map<string, Set<string>>) {
  const emits: EmitRecord[] = [];
  const fakeIo = {
    emit: jest.fn((event: string, payload: Record<string, unknown>) => {
      emits.push({ room: '*', event, payload });
    }),
    to: jest.fn((room: string) => ({
      emit: jest.fn((event: string, payload: Record<string, unknown>) => {
        emits.push({ room, event, payload });
      }),
    })),
    of: jest.fn(() => ({
      adapter: {
        rooms: {
          get: jest.fn((room: string) => roomMembers.get(room)),
        },
      },
    })),
    sockets: {
      sockets: new Map(),
      adapter: { rooms: new Map() },
    },
  };
  return { fakeIo, emits };
}

process.env.NODE_ENV = 'test';
// Ensure the socket circuit breaker is closed so emits aren't swallowed.
delete process.env.FF_CIRCUIT_BREAKER_ENABLED;

import * as socketService from '../shared/services/socket.service';

describe('F-B-26: Durable Emit Contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSeqByKey.clear();
    delete process.env.FF_DURABLE_EMIT_ENABLED;
  });

  describe('FF_DURABLE_EMIT_ENABLED off/unset (baseline — pre-F-B-26 behaviour preserved)', () => {
    it('emitToUser does NOT write to socket:unacked ZSET for lifecycle events', () => {
      const { fakeIo } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-1', 'trip_assigned', { id: 't1' });
      expect(mockRedisZAdd).not.toHaveBeenCalled();
      expect(mockRedisIncr).not.toHaveBeenCalledWith('socket:seq:user-1');
    });

    it('emitToBooking does NOT ZADD for lifecycle events', () => {
      const { fakeIo } = makeFakeIo(new Map([['booking:b1', new Set(['s1'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([['s1', 'user-1']]));
      socketService.emitToBooking('b1', 'booking_updated', { id: 'b1' });
      expect(mockRedisZAdd).not.toHaveBeenCalled();
    });

    it('emitToOrder does NOT ZADD for lifecycle events', () => {
      const { fakeIo } = makeFakeIo(new Map([['order:o1', new Set(['s1'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([['s1', 'user-1']]));
      socketService.emitToOrder('o1', 'order_cancelled', { id: 'o1' });
      expect(mockRedisZAdd).not.toHaveBeenCalled();
    });

    it('emitToUsers does NOT ZADD for lifecycle events', () => {
      const { fakeIo } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUsers(['user-1', 'user-2'], 'trip_assigned', { id: 't1' });
      expect(mockRedisZAdd).not.toHaveBeenCalled();
    });
  });

  describe('FF_DURABLE_EMIT_ENABLED=true (F-B-26 durable path ACTIVE)', () => {
    beforeEach(() => {
      process.env.FF_DURABLE_EMIT_ENABLED = 'true';
    });

    afterEach(() => {
      delete process.env.FF_DURABLE_EMIT_ENABLED;
    });

    it('emitToUser writes envelope to socket:unacked:{userId} before fanout', async () => {
      const { fakeIo, emits } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-42', 'trip_assigned', { tripId: 't42' });
      // Flush pending microtasks (durableEmit is async fire-and-forget)
      await new Promise((r) => setImmediate(r));
      expect(mockRedisIncr).toHaveBeenCalledWith('socket:seq:user-42');
      expect(mockRedisZAdd).toHaveBeenCalledTimes(1);
      const [zsetKey, score, envelope] = mockRedisZAdd.mock.calls[0];
      expect(zsetKey).toBe('socket:unacked:user-42');
      expect(score).toBe(1);
      expect(typeof envelope).toBe('string');
      const parsed = JSON.parse(envelope as string);
      expect(parsed).toMatchObject({
        seq: 1,
        event: 'trip_assigned',
        payload: { tripId: 't42' },
      });
      expect(typeof parsed.createdAt).toBe('number');
      // TTL refresh happens in parallel with zAdd
      expect(mockRedisExpire).toHaveBeenCalledWith('socket:unacked:user-42', 600);
      // Emit also fired via adapter
      expect(emits.length).toBe(1);
      expect(emits[0]).toMatchObject({ room: 'user:user-42', event: 'trip_assigned' });
      expect(emits[0].payload).toMatchObject({ tripId: 't42', _seq: 1 });
    });

    it('emitToBooking enumerates local room users + ZADDs each before room broadcast', async () => {
      const { fakeIo, emits } = makeFakeIo(new Map([['booking:b7', new Set(['s1', 's2'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([
        ['s1', 'user-A'],
        ['s2', 'user-B'],
      ]));
      socketService.emitToBooking('b7', 'booking_updated', { id: 'b7' });
      await new Promise((r) => setImmediate(r));
      // Two users in the room → two ZADDs under per-user keys
      expect(mockRedisZAdd).toHaveBeenCalledTimes(2);
      const keys = mockRedisZAdd.mock.calls.map((c) => c[0]).sort();
      expect(keys).toEqual(['socket:unacked:user-A', 'socket:unacked:user-B']);
      // Room broadcast still happens (for cross-instance live delivery)
      expect(emits.some((e) => e.room === 'booking:b7' && e.event === 'booking_updated')).toBe(true);
    });

    it('emitToOrder persists envelopes for each local order-room member', async () => {
      const { fakeIo } = makeFakeIo(new Map([['order:o9', new Set(['s1', 's2', 's3'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([
        ['s1', 'user-A'],
        ['s2', 'user-B'],
        ['s3', 'user-A'], // duplicate userId via separate socket — dedup
      ]));
      socketService.emitToOrder('o9', 'order_cancelled', { reason: 'timeout' });
      await new Promise((r) => setImmediate(r));
      // Dedup: user-A appears once even with two sockets in the room
      expect(mockRedisZAdd).toHaveBeenCalledTimes(2);
      const keys = mockRedisZAdd.mock.calls.map((c) => c[0]).sort();
      expect(keys).toEqual(['socket:unacked:user-A', 'socket:unacked:user-B']);
    });

    it('emitToUsers persists an envelope for each unique userId in the input list', async () => {
      const { fakeIo } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUsers(['uA', 'uB', 'uA'], 'new_broadcast', { orderId: 'o1' });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisZAdd).toHaveBeenCalledTimes(2);
      const keys = mockRedisZAdd.mock.calls.map((c) => c[0]).sort();
      expect(keys).toEqual(['socket:unacked:uA', 'socket:unacked:uB']);
    });

    it('emitToAllTransporters persists envelopes for role:transporter room members', async () => {
      const { fakeIo } = makeFakeIo(new Map([['role:transporter', new Set(['s1', 's2'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([
        ['s1', 'trans-1'],
        ['s2', 'trans-2'],
      ]));
      socketService.emitToAllTransporters('new_broadcast', { orderId: 'o1' });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisZAdd).toHaveBeenCalledTimes(2);
      const keys = mockRedisZAdd.mock.calls.map((c) => c[0]).sort();
      expect(keys).toEqual(['socket:unacked:trans-1', 'socket:unacked:trans-2']);
    });

    it('emitToTransporterDrivers persists envelopes for transporter:{id} room members', async () => {
      const { fakeIo } = makeFakeIo(new Map([['transporter:t1', new Set(['s1'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([['s1', 'driver-1']]));
      socketService.emitToTransporterDrivers('t1', 'truck_confirmed', { id: 't1' });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisZAdd).toHaveBeenCalledTimes(1);
      expect(mockRedisZAdd.mock.calls[0][0]).toBe('socket:unacked:driver-1');
    });

    it('emitToRoom persists envelopes for ad-hoc room members', async () => {
      const { fakeIo } = makeFakeIo(new Map([['custom:room', new Set(['s1', 's2'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([
        ['s1', 'user-X'],
        ['s2', 'user-Y'],
      ]));
      socketService.emitToRoom('custom:room', 'hold_expired', { reason: 'timeout' });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisZAdd).toHaveBeenCalledTimes(2);
    });

    it('telemetry events (location_updated) are NEVER ZADDed even with FF on', () => {
      const { fakeIo } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-1', 'location_updated', { lat: 0, lng: 0 });
      socketService.emitToUser('user-1', 'broadcast_countdown', { remaining: 45 });
      expect(mockRedisZAdd).not.toHaveBeenCalled();
    });

    it('emitToTrip does not ZADD LOCATION_UPDATED regardless of flag', () => {
      const { fakeIo } = makeFakeIo(new Map([['trip:t1', new Set(['s1'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([['s1', 'u1']]));
      socketService.emitToTrip('t1', 'location_updated', { lat: 0, lng: 0 });
      expect(mockRedisZAdd).not.toHaveBeenCalled();
    });

    it('emitToTrip DOES ZADD for lifecycle trip events (trip_assigned, order_completed)', async () => {
      const { fakeIo } = makeFakeIo(new Map([['trip:t1', new Set(['s1'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([['s1', 'u1']]));
      socketService.emitToTrip('t1', 'order_completed', { id: 't1' });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisZAdd).toHaveBeenCalledTimes(1);
      expect(mockRedisZAdd.mock.calls[0][0]).toBe('socket:unacked:u1');
    });

    it('empty room does not crash and does not ZADD', async () => {
      const { fakeIo } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToBooking('empty', 'booking_updated', { id: 'empty' });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisZAdd).not.toHaveBeenCalled();
    });

    it('ZSET write failure degrades to non-durable emit (best-effort)', async () => {
      mockRedisZAdd.mockRejectedValueOnce(new Error('redis down'));
      const { fakeIo, emits } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-1', 'trip_assigned', { id: 't1' });
      await new Promise((r) => setImmediate(r));
      // Emit still fires even after ZADD rejects
      expect(emits.some((e) => e.event === 'trip_assigned' && e.room === 'user:user-1')).toBe(true);
      expect(mockLoggerWarn).toHaveBeenCalled();
    });
  });
});
