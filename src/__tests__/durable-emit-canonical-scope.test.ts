/**
 * =============================================================================
 * F-B-26: Durable-emit canonical SEED scope test
 * =============================================================================
 *
 * Canonical seed contract (pre-F-B-31/34 downstream expansion):
 *
 *   1. `DURABLE_EMIT_EXPANDED_EVENTS` is an exported, empty opt-in `Set<string>`
 *      that downstream canonicalization waves (F-B-31 split-brain unify,
 *      F-B-34 per-user seq for broadcast surface) populate per event family.
 *
 *   2. When an event name is in `DURABLE_EMIT_EXPANDED_EVENTS` and
 *      `FF_DURABLE_EMIT_ENABLED` is on, `emitToUser` stamps
 *      `socket:seq:${userId}` (per-user) and writes the envelope — exactly the
 *      same path lifecycle events already take. Until the opt-in set is
 *      populated by downstream work, behavior is unchanged.
 *
 *   3. The canonical entry for user-scoped durable delivery is `emitToUser`,
 *      routing through `durableEmit()`; the per-user `socket:seq:${userId}`
 *      INCR (NOT a global `socket:global_seq`) is the monotonic scoping that
 *      lets reconnect-replay drain in per-user order.
 *
 * RED before F-B-26 seed: `DURABLE_EMIT_EXPANDED_EVENTS` does not exist and
 * adding an event to a (non-existent) set has no effect.
 *
 * =============================================================================
 */

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

const mockSeqByKey = new Map<string, number>();
const mockRedisIncr = jest.fn(async (key: string) => {
  const next = (mockSeqByKey.get(key) ?? 0) + 1;
  mockSeqByKey.set(key, next);
  return next;
});
const mockRedisZAdd = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(true);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: (key: string) => mockRedisIncr(key),
    incrBy: jest.fn().mockResolvedValue(1),
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
    zRangeByScore: jest.fn().mockResolvedValue([]),
    zRemRangeByScore: jest.fn().mockResolvedValue(0),
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

interface EmitRecord {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

function makeFakeIo() {
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
      adapter: { rooms: { get: jest.fn(() => undefined) } },
    })),
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  };
  return { fakeIo, emits };
}

process.env.NODE_ENV = 'test';
delete process.env.FF_CIRCUIT_BREAKER_ENABLED;

import * as socketService from '../shared/services/socket.service';

describe('F-B-26: Durable-emit canonical SEED scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSeqByKey.clear();
    delete process.env.FF_DURABLE_EMIT_ENABLED;
    const expanded = (socketService as unknown as {
      DURABLE_EMIT_EXPANDED_EVENTS?: Set<string>;
    }).DURABLE_EMIT_EXPANDED_EVENTS;
    if (expanded) expanded.clear();
  });

  afterEach(() => {
    const expanded = (socketService as unknown as {
      DURABLE_EMIT_EXPANDED_EVENTS?: Set<string>;
    }).DURABLE_EMIT_EXPANDED_EVENTS;
    if (expanded) expanded.clear();
  });

  describe('canonical surface shape', () => {
    it('exports DURABLE_EMIT_EXPANDED_EVENTS as an empty Set<string>', () => {
      const mod = socketService as unknown as {
        DURABLE_EMIT_EXPANDED_EVENTS?: unknown;
      };
      expect(mod.DURABLE_EMIT_EXPANDED_EVENTS).toBeInstanceOf(Set);
      expect((mod.DURABLE_EMIT_EXPANDED_EVENTS as Set<string>).size).toBe(0);
    });
  });

  describe('FF_DURABLE_EMIT_ENABLED=true + event added to expanded set', () => {
    beforeEach(() => {
      process.env.FF_DURABLE_EMIT_ENABLED = 'true';
    });

    it('emitToUser of a NON-lifecycle event opted into expanded set INCRs socket:seq:{userId}', async () => {
      const expanded = (socketService as unknown as {
        DURABLE_EMIT_EXPANDED_EVENTS: Set<string>;
      }).DURABLE_EMIT_EXPANDED_EVENTS;
      expanded.add('custom_progress');

      const { fakeIo } = makeFakeIo();
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-seed', 'custom_progress', { pct: 40 });
      await new Promise((r) => setImmediate(r));

      expect(mockRedisIncr).toHaveBeenCalledWith('socket:seq:user-seed');
      expect(mockRedisIncr).not.toHaveBeenCalledWith('socket:global_seq');
      expect(mockRedisZAdd).toHaveBeenCalledTimes(1);
      expect(mockRedisZAdd.mock.calls[0][0]).toBe('socket:unacked:user-seed');
    });

    it('non-lifecycle event NOT in expanded set stays on legacy path (no ZADD)', async () => {
      const { fakeIo } = makeFakeIo();
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-seed', 'custom_progress', { pct: 40 });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisZAdd).not.toHaveBeenCalled();
      expect(mockRedisIncr).not.toHaveBeenCalledWith('socket:seq:user-seed');
    });

    it('lifecycle events retain the existing durable path even when expanded set is empty', async () => {
      const { fakeIo } = makeFakeIo();
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-42', 'trip_assigned', { tripId: 't42' });
      await new Promise((r) => setImmediate(r));
      expect(mockRedisIncr).toHaveBeenCalledWith('socket:seq:user-42');
      expect(mockRedisZAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe('FF off (default) — expanded set entries remain inert', () => {
    it('does NOT ZADD even if event is in expanded set', async () => {
      const expanded = (socketService as unknown as {
        DURABLE_EMIT_EXPANDED_EVENTS: Set<string>;
      }).DURABLE_EMIT_EXPANDED_EVENTS;
      expanded.add('custom_progress');

      const { fakeIo } = makeFakeIo();
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-seed', 'custom_progress', { pct: 40 });
      await new Promise((r) => setImmediate(r));

      expect(mockRedisZAdd).not.toHaveBeenCalled();
    });
  });
});
