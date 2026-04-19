/**
 * =============================================================================
 * F-B-26: Per-User Monotonic Sequence Tests
 * =============================================================================
 *
 * Asserts that durable-emit uses `socket:seq:{userId}` for sequence numbering,
 * so seq counters are independent across users (unlike the pre-F-B-26
 * `socket:global_seq` counter, which conflated all users).
 *
 * Key invariants tested:
 *   1. Two users get independent seq counters (u1→1,2,3 while u2→1,2,3).
 *   2. Same user's seq is monotonically increasing across emits.
 *   3. The envelope written to `socket:unacked:{userId}` uses THAT user's seq,
 *      matching what the ACK handler (zRemRangeByScore keyed by userId) prunes.
 *   4. With FF off, no per-user INCR happens — the global counter path stays.
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

// Per-key counter matching real Redis INCR semantics — independent per key.
const seqByKey = new Map<string, number>();
const mockRedisIncr = jest.fn(async (key: string) => {
  const next = (seqByKey.get(key) ?? 0) + 1;
  seqByKey.set(key, next);
  return next;
});

interface ZAddCall {
  key: string;
  score: number;
  envelope: string;
}
const zAddCalls: ZAddCall[] = [];
const mockRedisZAdd = jest.fn(async (key: string, score: number, envelope: string) => {
  zAddCalls.push({ key, score, envelope });
  return 1;
});
const mockRedisExpire = jest.fn().mockResolvedValue(true);
const mockRedisIncrBy = jest.fn().mockResolvedValue(1);

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
    zAdd: (key: string, score: number, envelope: string) => mockRedisZAdd(key, score, envelope),
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

function makeFakeIo(roomMembers: Map<string, Set<string>>) {
  const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  const fakeIo = {
    emit: jest.fn(),
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
delete process.env.FF_CIRCUIT_BREAKER_ENABLED;

import * as socketService from '../shared/services/socket.service';

describe('F-B-26: Per-User Monotonic Sequence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seqByKey.clear();
    zAddCalls.length = 0;
    process.env.FF_DURABLE_EMIT_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.FF_DURABLE_EMIT_ENABLED;
  });

  it('two users receive independent monotonic seq counters (1,2,3 each)', async () => {
    const { fakeIo } = makeFakeIo(new Map());
    socketService.__setIoForTesting(fakeIo, new Map());

    // Emit 3 lifecycle events to each user
    for (let i = 0; i < 3; i++) {
      socketService.emitToUser('user-alpha', 'trip_assigned', { n: i });
      socketService.emitToUser('user-beta', 'trip_assigned', { n: i });
    }
    await new Promise((r) => setImmediate(r));

    // Each user should have 3 ZADDs under their own key
    const alphaCalls = zAddCalls.filter((c) => c.key === 'socket:unacked:user-alpha');
    const betaCalls = zAddCalls.filter((c) => c.key === 'socket:unacked:user-beta');
    expect(alphaCalls).toHaveLength(3);
    expect(betaCalls).toHaveLength(3);

    // Seq counters independent per user — both start at 1, go 1,2,3
    expect(alphaCalls.map((c) => c.score)).toEqual([1, 2, 3]);
    expect(betaCalls.map((c) => c.score)).toEqual([1, 2, 3]);
  });

  it('same user seq is monotonically increasing within a burst', async () => {
    const { fakeIo } = makeFakeIo(new Map());
    socketService.__setIoForTesting(fakeIo, new Map());

    const events = ['trip_assigned', 'booking_updated', 'driver_accepted', 'hold_expired'];
    for (const ev of events) {
      socketService.emitToUser('user-single', ev, { ev });
    }
    await new Promise((r) => setImmediate(r));

    const calls = zAddCalls.filter((c) => c.key === 'socket:unacked:user-single');
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.score)).toEqual([1, 2, 3, 4]);

    // Seq in the envelope matches the ZADD score — consistency between the
    // persisted envelope and the score used for ACK pruning by zRemRangeByScore.
    for (const call of calls) {
      const envelope = JSON.parse(call.envelope);
      expect(envelope.seq).toBe(call.score);
    }
  });

  it('room emit uses per-user INCR keys (each recipient has independent counter)', async () => {
    const { fakeIo } = makeFakeIo(new Map([
      ['order:o1', new Set(['s1', 's2', 's3'])],
    ]));
    socketService.__setIoForTesting(fakeIo, new Map([
      ['s1', 'uA'],
      ['s2', 'uB'],
      ['s3', 'uC'],
    ]));

    socketService.emitToOrder('o1', 'order_cancelled', { id: 'o1' });
    await new Promise((r) => setImmediate(r));

    // Each user gets their own INCR key — verified by inspecting mock calls
    const incrKeys = (mockRedisIncr as unknown as jest.Mock).mock.calls.map((c: unknown[]) => c[0]);
    expect(incrKeys).toContain('socket:seq:uA');
    expect(incrKeys).toContain('socket:seq:uB');
    expect(incrKeys).toContain('socket:seq:uC');

    // Each user's envelope sits at seq=1 in THEIR OWN ZSET — independent counters
    expect(zAddCalls.filter((c) => c.key === 'socket:unacked:uA')).toHaveLength(1);
    expect(zAddCalls.filter((c) => c.key === 'socket:unacked:uB')).toHaveLength(1);
    expect(zAddCalls.filter((c) => c.key === 'socket:unacked:uC')).toHaveLength(1);

    for (const key of ['socket:unacked:uA', 'socket:unacked:uB', 'socket:unacked:uC']) {
      const call = zAddCalls.find((c) => c.key === key);
      expect(call?.score).toBe(1);
    }
  });

  it('envelope is keyed-consistent: seq in JSON matches the ZADD score', async () => {
    const { fakeIo } = makeFakeIo(new Map());
    socketService.__setIoForTesting(fakeIo, new Map());
    socketService.emitToUser('user-x', 'new_broadcast', { orderId: 'o1' });
    socketService.emitToUser('user-x', 'new_broadcast', { orderId: 'o2' });
    await new Promise((r) => setImmediate(r));

    const userCalls = zAddCalls.filter((c) => c.key === 'socket:unacked:user-x');
    expect(userCalls).toHaveLength(2);
    for (const call of userCalls) {
      const env = JSON.parse(call.envelope);
      expect(env.seq).toBe(call.score);
      expect(env.event).toBe('new_broadcast');
      expect(typeof env.createdAt).toBe('number');
    }
  });

  it('with FF off, no per-user INCR calls are made — baseline preserved', () => {
    delete process.env.FF_DURABLE_EMIT_ENABLED;
    const { fakeIo } = makeFakeIo(new Map());
    socketService.__setIoForTesting(fakeIo, new Map());

    socketService.emitToUser('user-1', 'trip_assigned', { id: 't1' });
    socketService.emitToUser('user-2', 'booking_updated', { id: 'b1' });

    const incrCalls = (mockRedisIncr as unknown as jest.Mock).mock.calls;
    // None of the calls should have `socket:seq:*` keys
    const seqIncrCalls = incrCalls.filter((c: unknown[]) => String(c[0]).startsWith('socket:seq:'));
    expect(seqIncrCalls).toHaveLength(0);
    expect(zAddCalls).toHaveLength(0);
  });

  it('telemetry emits do NOT increment per-user seq even with FF on', () => {
    const { fakeIo } = makeFakeIo(new Map());
    socketService.__setIoForTesting(fakeIo, new Map());

    socketService.emitToUser('user-1', 'location_updated', { lat: 0, lng: 0 });
    socketService.emitToUser('user-1', 'broadcast_countdown', { t: 45 });

    const incrCalls = (mockRedisIncr as unknown as jest.Mock).mock.calls;
    const seqIncrCalls = incrCalls.filter((c: unknown[]) => String(c[0]).startsWith('socket:seq:'));
    expect(seqIncrCalls).toHaveLength(0);
  });

  it('emitToUsers across many users — each userId gets its own seq=1', async () => {
    const { fakeIo } = makeFakeIo(new Map());
    socketService.__setIoForTesting(fakeIo, new Map());
    const userIds = Array.from({ length: 10 }, (_, i) => `u${i}`);
    socketService.emitToUsers(userIds, 'new_broadcast', { orderId: 'o1' });
    await new Promise((r) => setImmediate(r));

    expect(zAddCalls).toHaveLength(10);
    for (const userId of userIds) {
      const call = zAddCalls.find((c) => c.key === `socket:unacked:${userId}`);
      expect(call).toBeDefined();
      expect(call?.score).toBe(1);
    }
  });
});
