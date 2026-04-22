/**
 * =============================================================================
 * A09-002 / A12-009 (Arch 1B) — Role-scoped Durable-Emit ZSET Phase 1 Atomicity
 * =============================================================================
 *
 * Asserts that the Phase-1 MULTI/EXEC atomic dual-write in `durableEmit`:
 *
 *   1. Writes to BOTH `socket:unacked:{userId}` AND `socket:unacked:{userId}:{role}`
 *      when FF_ROLE_SCOPED_DURABLE_EMIT is ON.
 *   2. Tags envelopes with `role`.
 *   3. Emits `socket_unacked_key_version` {v1, v2} per successful dual-write.
 *   4. On pipeline abort (mocked by throwing on tx.exec()), catches the thrown
 *      AppError('DURABLE_EMIT_DUAL_WRITE_FAILED') via the outer try/catch and
 *      degrades to plain-emit fallback without writing to either key.
 *   5. Increments `socket_unacked_dual_write_fail_total` {phase:'1'} on abort.
 *   6. Logs 'durable_emit_dual_write_failed' with sanitized error message.
 *   7. Does NOT increment `socket_unacked_key_version` on abort.
 *
 * Baseline: when the flag is OFF (default), behaviour is identical to the
 * pre-Phase-1 single-key path; no MULTI pipeline is used.
 *
 * Ref: master-file §A09-002, §A12-009, plan §7.3.2 W3-T10, Arch 1B amendment.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// MOCK SETUP — must precede any socket.service import
// ---------------------------------------------------------------------------

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

const mockIncrementCounter = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...args: unknown[]) => mockIncrementCounter(...args),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

// In-memory mock ZSET + seq counter. Mirrors Redis INCR semantics.
interface MockZSetEntry { score: number; member: string }
const mockZSets = new Map<string, MockZSetEntry[]>();
const mockSeqByKey = new Map<string, number>();

const mockRedisIncr = jest.fn(async (key: string) => {
  const next = (mockSeqByKey.get(key) ?? 0) + 1;
  mockSeqByKey.set(key, next);
  return next;
});
const mockRedisZAdd = jest.fn(async (key: string, score: number, member: string) => {
  const arr = mockZSets.get(key) ?? [];
  arr.push({ score, member });
  mockZSets.set(key, arr);
  return 1;
});
const mockRedisExpire = jest.fn().mockResolvedValue(true);

// MULTI/EXEC transaction mock. Default: success. Override `mockMultiExec` per
// case (e.g. reject on second zAdd) to exercise the atomicity failure path.
// Matches IRedisTransaction shape: chainable methods returning `this`, exec()
// returns Promise<any[]>. On abort, the ATOMIC contract in redis.service.ts
// throws from exec() — we simulate that here directly.
type MultiQueuedOp = { type: 'zAdd' | 'expire'; args: any[] };

let mockMultiExecImpl: (ops: MultiQueuedOp[]) => Promise<any[]> = async (ops) => {
  // Default: apply all ops in order against the in-memory store; succeed.
  const results: any[] = [];
  for (const op of ops) {
    if (op.type === 'zAdd') {
      const [key, score, member] = op.args;
      const arr = mockZSets.get(key) ?? [];
      arr.push({ score, member });
      mockZSets.set(key, arr);
      results.push(1);
    } else {
      results.push(1);
    }
  }
  return results;
};

const mockRedisMulti = jest.fn(() => {
  const ops: MultiQueuedOp[] = [];
  const tx: any = {
    zAdd(key: string, score: number, member: string) {
      ops.push({ type: 'zAdd', args: [key, score, member] });
      return tx;
    },
    expire(key: string, ttl: number) {
      ops.push({ type: 'expire', args: [key, ttl] });
      return tx;
    },
    set() { return tx; },
    del() { return tx; },
    sAdd() { return tx; },
    sRem() { return tx; },
    incr() { return tx; },
    exec: () => mockMultiExecImpl(ops),
  };
  return tx;
});

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: (key: string) => mockRedisIncr(key),
    incrBy: jest.fn().mockResolvedValue(1),
    expire: (key: string, ttl: number) => mockRedisExpire(key, ttl),
    exists: jest.fn().mockResolvedValue(false),
    sAdd: jest.fn().mockResolvedValue(1),
    sIsMember: jest.fn().mockResolvedValue(false),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    getJSON: jest.fn(),
    setJSON: jest.fn(),
    lPush: jest.fn(),
    lTrim: jest.fn(),
    zAdd: (...args: unknown[]) => mockRedisZAdd(args[0] as string, args[1] as number, args[2] as string),
    zRangeByScore: jest.fn().mockResolvedValue([]),
    zRemRangeByScore: jest.fn().mockResolvedValue(0),
    multi: () => mockRedisMulti(),
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
// Fake io
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
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  };
  return { fakeIo, emits };
}

process.env.NODE_ENV = 'test';
delete process.env.FF_CIRCUIT_BREAKER_ENABLED;
// DURABLE_EMIT_ENABLED default is implicit-on; explicit ON via env for clarity.
process.env.FF_DURABLE_EMIT_ENABLED = 'true';

import * as socketService from '../shared/services/socket.service';

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('A09-002 / A12-009 — Role-scoped ZSET Phase 1 atomicity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSeqByKey.clear();
    mockZSets.clear();
    mockMultiExecImpl = async (ops) => {
      const results: any[] = [];
      for (const op of ops) {
        if (op.type === 'zAdd') {
          const [key, score, member] = op.args;
          const arr = mockZSets.get(key) ?? [];
          arr.push({ score, member });
          mockZSets.set(key, arr);
          results.push(1);
        } else {
          results.push(1);
        }
      }
      return results;
    };
    socketService.__clearUserRoleCacheForTesting();
  });

  afterEach(() => {
    delete process.env.FF_ROLE_SCOPED_DURABLE_EMIT;
  });

  describe('flag OFF (baseline — legacy single-key write preserved)', () => {
    it('emits to OLD key only and never calls redisService.multi()', async () => {
      process.env.FF_ROLE_SCOPED_DURABLE_EMIT = 'false';
      const { fakeIo } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.__setUserRoleForTesting('u-base', 'transporter');

      socketService.emitToUser('u-base', 'trip_assigned', { id: 't1' });
      await new Promise((r) => setImmediate(r));

      expect(mockRedisMulti).not.toHaveBeenCalled();
      expect(mockRedisZAdd).toHaveBeenCalledTimes(1);
      expect(mockRedisZAdd.mock.calls[0][0]).toBe('socket:unacked:u-base');
      expect(mockZSets.has('socket:unacked:u-base:transporter')).toBe(false);
      expect(mockIncrementCounter).toHaveBeenCalledWith('socket_unacked_key_version', { version: 'v1' });
      expect(mockIncrementCounter).not.toHaveBeenCalledWith('socket_unacked_key_version', { version: 'v2' });
    });
  });

  describe('flag ON — happy path (atomic dual-write succeeds)', () => {
    beforeEach(() => {
      process.env.FF_ROLE_SCOPED_DURABLE_EMIT = 'true';
    });

    it('writes envelope to BOTH OLD and NEW keys via a single MULTI/EXEC pipeline', async () => {
      const { fakeIo, emits } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.__setUserRoleForTesting('u-42', 'transporter');

      socketService.emitToUser('u-42', 'trip_assigned', { tripId: 't42' });
      await new Promise((r) => setImmediate(r));

      // Exactly one MULTI pipeline used.
      expect(mockRedisMulti).toHaveBeenCalledTimes(1);
      // Direct zAdd() not called (all writes go through the pipeline).
      expect(mockRedisZAdd).not.toHaveBeenCalled();

      // Both keys populated by the pipeline.
      const oldKey = 'socket:unacked:u-42';
      const newKey = 'socket:unacked:u-42:transporter';
      expect(mockZSets.get(oldKey)?.length).toBe(1);
      expect(mockZSets.get(newKey)?.length).toBe(1);

      // Envelope carries role tag.
      const envelope = mockZSets.get(newKey)![0].member;
      const parsed = JSON.parse(envelope);
      expect(parsed).toMatchObject({
        seq: 1,
        event: 'trip_assigned',
        payload: { tripId: 't42' },
        role: 'transporter',
      });

      // Both key-version metrics incremented exactly once.
      expect(mockIncrementCounter).toHaveBeenCalledWith('socket_unacked_key_version', { version: 'v1' });
      expect(mockIncrementCounter).toHaveBeenCalledWith('socket_unacked_key_version', { version: 'v2' });
      // No failure metric on success.
      expect(mockIncrementCounter).not.toHaveBeenCalledWith('socket_unacked_dual_write_fail_total', expect.anything());

      // Emit still fires (outer path unaffected).
      expect(emits.length).toBe(1);
      expect(emits[0]).toMatchObject({ room: 'user:u-42', event: 'trip_assigned' });
    });

    it('falls back to ROLE_UNKNOWN when userRoleCache has no entry', async () => {
      const { fakeIo } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      // NOTE: no __setUserRoleForTesting call → cache miss.

      socketService.emitToUser('u-miss', 'new_broadcast', { id: 'b1' });
      await new Promise((r) => setImmediate(r));

      expect(mockZSets.get('socket:unacked:u-miss:unknown')?.length).toBe(1);
      const envelope = mockZSets.get('socket:unacked:u-miss:unknown')![0].member;
      expect(JSON.parse(envelope).role).toBe('unknown');
    });
  });

  describe('flag ON — atomicity abort (MUST per Arch 1B)', () => {
    beforeEach(() => {
      process.env.FF_ROLE_SCOPED_DURABLE_EMIT = 'true';
    });

    it('throws DURABLE_EMIT_DUAL_WRITE_FAILED when pipeline exec rejects; neither key persisted', async () => {
      // Mock the SECOND zAdd op (idx 2 in the ops array: [zAdd old, expire old, zAdd new, expire new])
      // to reject the whole pipeline exec. Matches ioredis MULTI/EXEC abort semantics.
      mockMultiExecImpl = async (_ops) => {
        throw new Error('mock ZADD fail on second write');
      };

      const { fakeIo, emits } = makeFakeIo(new Map());
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.__setUserRoleForTesting('u-abort', 'driver');

      socketService.emitToUser('u-abort', 'hold_expired', { holdId: 'h1' });
      await new Promise((r) => setImmediate(r));

      // Neither OLD nor NEW key received the envelope — atomicity preserved.
      expect(mockZSets.has('socket:unacked:u-abort')).toBe(false);
      expect(mockZSets.has('socket:unacked:u-abort:driver')).toBe(false);

      // Failure metric incremented exactly once.
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        'socket_unacked_dual_write_fail_total',
        { phase: '1' }
      );
      // No successful key-version metric emitted on abort.
      expect(mockIncrementCounter).not.toHaveBeenCalledWith('socket_unacked_key_version', { version: 'v1' });
      expect(mockIncrementCounter).not.toHaveBeenCalledWith('socket_unacked_key_version', { version: 'v2' });

      // Structured error log emitted with sanitized message.
      const errorLog = mockLoggerError.mock.calls.find((c) => c[0] === 'durable_emit_dual_write_failed');
      expect(errorLog).toBeDefined();
      expect(errorLog![1]).toMatchObject({
        userId: 'u-abort',
        role: 'driver',
        event: 'hold_expired',
        errMessage: expect.stringContaining('mock ZADD fail'),
      });

      // Outer try/catch caught the thrown AppError → warn log from the legacy
      // "ZSET write failed" branch fires; emit still fires degraded.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[durableEmit] ZSET write failed, emitting without durable persistence',
        expect.objectContaining({ userId: 'u-abort', event: 'hold_expired' })
      );
      expect(emits.length).toBe(1);
    });
  });

  describe('persistRoomEnvelopes — same atomicity contract per user', () => {
    beforeEach(() => {
      process.env.FF_ROLE_SCOPED_DURABLE_EMIT = 'true';
    });

    it('dual-writes per-user inside the room fan-out map', async () => {
      const { fakeIo } = makeFakeIo(new Map([['booking:b1', new Set(['s1', 's2'])]]));
      socketService.__setIoForTesting(fakeIo, new Map([
        ['s1', 'room-u-1'],
        ['s2', 'room-u-2'],
      ]));
      socketService.__setUserRoleForTesting('room-u-1', 'transporter');
      socketService.__setUserRoleForTesting('room-u-2', 'driver');

      socketService.emitToBooking('b1', 'booking_updated', { id: 'b1' });
      await new Promise((r) => setImmediate(r));

      // Two users → two MULTI pipelines (one each).
      expect(mockRedisMulti).toHaveBeenCalledTimes(2);
      expect(mockZSets.has('socket:unacked:room-u-1:transporter')).toBe(true);
      expect(mockZSets.has('socket:unacked:room-u-2:driver')).toBe(true);
    });
  });
});
