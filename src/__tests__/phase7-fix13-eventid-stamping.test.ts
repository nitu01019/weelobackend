/**
 * =============================================================================
 * Phase 7 — Fix #13: eventId stamping across retransmission paths
 * =============================================================================
 *
 * Asserts the four-path invariant from Finding #13 (DDIA Ch.11 §"Idempotent
 * Consumers"): the SAME UUIDv4 `eventId` must appear on the wire for the same
 * logical business event regardless of whether it travels via:
 *   (i)  live durableEmit emit       (socket.service.ts Section 1.6)
 *   (ii) ZSET-persisted envelope     (socket.service.ts Section 1.5)
 *   (iii) Phase-4 reconnect replay   (socket.service.ts Section 2)
 *   (iv) DLQ replay                  (queue.service.ts  Section 3)
 *
 * Plus the AsyncAPI contract bump (Section 4): info.version === '1.1.0' AND
 * components.messageTraits.DedupableEvent.headers.required === ['eventId'].
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
const mockRedisIncrBy = jest.fn().mockResolvedValue(1);
const mockRedisLPush = jest.fn().mockResolvedValue(1);
const mockRedisLTrim = jest.fn().mockResolvedValue('OK');

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
    lPush: (...args: unknown[]) => mockRedisLPush(...args),
    lTrim: (...args: unknown[]) => mockRedisLTrim(...args),
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
    emit: jest.fn(),
    to: jest.fn((room: string) => ({
      emit: jest.fn((event: string, payload: Record<string, unknown>) => {
        emits.push({ room, event, payload });
      }),
    })),
    of: jest.fn(() => ({
      adapter: { rooms: { get: jest.fn() } },
    })),
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  };
  return { fakeIo, emits };
}

process.env.NODE_ENV = 'test';
delete process.env.FF_CIRCUIT_BREAKER_ENABLED;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

import * as socketService from '../shared/services/socket.service';

describe('Phase 7 — Fix #13: eventId stamping across retransmission paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSeqByKey.clear();
    process.env.FF_DURABLE_EMIT_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.FF_DURABLE_EMIT_ENABLED;
  });

  describe('Sections 1 + 1.5 + 1.6 — durableEmit invariant (live + ZSET match)', () => {
    it('mints a UUIDv4 eventId when none provided, and the SAME eventId lands in (i) ZSET envelope payload, (ii) ZSET envelope top-level, and (iii) live emit payload', async () => {
      const { fakeIo, emits } = makeFakeIo();
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-42', 'trip_assigned', { tripId: 't42' });
      await new Promise((r) => setImmediate(r));

      expect(mockRedisZAdd).toHaveBeenCalledTimes(1);
      const [zsetKey, score, envelopeStr] = mockRedisZAdd.mock.calls[0];
      expect(zsetKey).toBe('socket:unacked:user-42');
      expect(score).toBe(1);
      const envelope = JSON.parse(envelopeStr as string);

      // ZSET envelope payload carries eventId
      expect(typeof envelope.payload.eventId).toBe('string');
      expect(envelope.payload.eventId).toMatch(UUID_V4);
      // ZSET envelope also has top-level eventId for legacy callers
      expect(envelope.eventId).toBe(envelope.payload.eventId);

      // Live emit carries the SAME eventId (matches the persisted envelope)
      expect(emits.length).toBe(1);
      expect(emits[0].room).toBe('user:user-42');
      expect(emits[0].event).toBe('trip_assigned');
      expect(emits[0].payload.eventId).toBe(envelope.payload.eventId);
      // _seq is still present alongside eventId
      expect(emits[0].payload._seq).toBe(1);
    });

    it('preserves a caller-provided eventId unchanged through all three channels', async () => {
      const { fakeIo, emits } = makeFakeIo();
      socketService.__setIoForTesting(fakeIo, new Map());
      const fixedId = '11111111-2222-4333-8444-555555555555';
      socketService.emitToUser('user-1', 'truck_confirmed', {
        truckId: 'tr-1',
        eventId: fixedId,
      });
      await new Promise((r) => setImmediate(r));

      const envelope = JSON.parse(mockRedisZAdd.mock.calls[0][2] as string);
      expect(envelope.payload.eventId).toBe(fixedId);
      expect(envelope.eventId).toBe(fixedId);
      expect(emits[0].payload.eventId).toBe(fixedId);
    });

    it('treats empty-string eventId as missing and mints a fresh UUID', async () => {
      const { fakeIo, emits } = makeFakeIo();
      socketService.__setIoForTesting(fakeIo, new Map());
      socketService.emitToUser('user-9', 'trip_assigned', { eventId: '' });
      await new Promise((r) => setImmediate(r));

      const envelope = JSON.parse(mockRedisZAdd.mock.calls[0][2] as string);
      expect(envelope.payload.eventId).toMatch(UUID_V4);
      expect(envelope.eventId).toBe(envelope.payload.eventId);
      expect(emits[0].payload.eventId).toBe(envelope.payload.eventId);
    });
  });

  describe('Section 2 — Phase-4 reconnect replay preserves eventId', () => {
    /**
     * Replicates the patched Phase-4 replay logic in socket.service.ts so the
     * invariant ("replayed payload carries envelope.payload.eventId, falling
     * back to envelope.eventId for legacy entries") is testable without
     * spinning up a real socket connection.
     */
    function replayShape(envelope: {
      event?: string;
      seq?: number;
      eventId?: string;
      payload: { eventId?: string; [k: string]: unknown };
    }): Record<string, unknown> {
      return {
        ...envelope.payload,
        eventId: envelope.payload?.eventId ?? envelope.eventId,
        _seq: envelope.seq,
        _replayed: true,
      };
    }

    it('forwards eventId from envelope.payload.eventId (post-Section-1.5 envelopes)', () => {
      const envelope = {
        seq: 7,
        event: 'trip_assigned',
        eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        payload: {
          tripId: 't42',
          eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        },
      };
      const replayed = replayShape(envelope);
      expect(replayed.eventId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      expect(replayed._replayed).toBe(true);
      expect(replayed._seq).toBe(7);
      expect((replayed as { tripId: string }).tripId).toBe('t42');
    });

    it('falls back to envelope.eventId for legacy envelopes lacking payload.eventId', () => {
      const envelope = {
        seq: 3,
        event: 'booking_updated',
        eventId: 'legacy0a-1234-4abc-8def-fedcba987654',
        payload: { id: 'b1' }, // legacy: no eventId on payload
      };
      const replayed = replayShape(envelope);
      expect(replayed.eventId).toBe('legacy0a-1234-4abc-8def-fedcba987654');
    });

    it('source asserts the patched expression is present in socket.service.ts', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.resolve(__dirname, '../shared/services/socket.service.ts'),
        'utf8'
      );
      // Phase 7 follow-up — Defect #2 added a defensive `?? randomUUID()` tail
      // to close the legacy-envelope undefined-eventId gap. The DDIA invariant
      // (payload eventId preferred, envelope eventId fallback) is unchanged;
      // the third fallback only fires for pre-Phase-7 envelopes during the
      // 10-min UNACKED_QUEUE_TTL window after deploy.
      expect(src).toContain(
        "eventId: envelope.payload?.eventId ?? envelope.eventId ?? randomUUID(),"
      );
    });
  });

  describe('Section 3 — DLQ entry stamps eventId at first enqueue', () => {
    it('queue.service.ts DLQ push stamps eventId via crypto.randomUUID()', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.resolve(__dirname, '../shared/services/queue.service.ts'),
        'utf8'
      );
      // Patched DLQ block: dataWithEventId added BEFORE JSON.stringify
      expect(src).toMatch(/const dataWithEventId = data && typeof data === 'object' && !Array.isArray\(data\)/);
      // Uses the file's top-level `import * as crypto from 'crypto'` (consistent with queue.service.ts:195/562/615).
      expect(src).toMatch(/eventId: \(data as any\)\.eventId \?\? crypto\.randomUUID\(\)/);
      expect(src).toMatch(/transporterId, event, data: dataWithEventId,/);
    });

    /**
     * Pure replication of the Section 3 stamping closure — lets us assert
     * the invariants without booting the full queue service.
     */
    function stampDlqData(data: unknown): unknown {
      return data && typeof data === 'object' && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), eventId: (data as { eventId?: string }).eventId ?? require('crypto').randomUUID() }
        : data;
    }

    it('mints a UUIDv4 eventId when none on raw data', () => {
      const stamped = stampDlqData({ orderId: 'o1' }) as { orderId: string; eventId: string };
      expect(stamped.orderId).toBe('o1');
      expect(stamped.eventId).toMatch(UUID_V4);
    });

    it('preserves a caller-provided eventId on DLQ entry', () => {
      const stamped = stampDlqData({ orderId: 'o2', eventId: 'fixed-id-aaaa-4bbb-8ccc-dddddddddddd' }) as { eventId: string };
      expect(stamped.eventId).toBe('fixed-id-aaaa-4bbb-8ccc-dddddddddddd');
    });
  });

  describe('Section 4 — AsyncAPI contract bump', () => {
    it('events.asyncapi.yaml info.version is 1.1.0 and DedupableEvent trait is additive', () => {
      const fs = require('fs');
      const path = require('path');
      const yamlPath = path.resolve(
        __dirname,
        '../../packages/contracts/events.asyncapi.yaml'
      );
      const text = fs.readFileSync(yamlPath, 'utf8');

      let parsed: any = null;
      try {
        const yaml = require('js-yaml');
        parsed = yaml.load(text);
      } catch {
        // js-yaml not installed — fall back to regex assertions
      }

      if (parsed) {
        expect(parsed.info.version).toBe('1.1.0');
        expect(parsed.components?.messageTraits?.DedupableEvent).toBeDefined();
        expect(parsed.components.messageTraits.DedupableEvent.headers.required).toEqual(['eventId']);
        expect(parsed.components.messageTraits.DedupableEvent['x-retention']).toBe('PT24H');
        expect(parsed.components.messageTraits.DedupableEvent['x-delivery-guarantee']).toBe('at-least-once');
        // Channels untouched (additive-only edit): preserved at 74 + aliases intact
        expect(Object.keys(parsed.channels).length).toBe(74);
        expect(parsed['x-event-aliases'].BROADCAST_CANCELLED).toBe('order_cancelled');
      } else {
        expect(text).toMatch(/^\s*version: 1\.1\.0\s*$/m);
        expect(text).toMatch(/DedupableEvent:/);
        expect(text).toMatch(/required: \[eventId\]/);
        expect(text).toMatch(/x-retention: PT24H/);
        expect(text).toMatch(/x-delivery-guarantee: at-least-once/);
      }
    });
  });
});
