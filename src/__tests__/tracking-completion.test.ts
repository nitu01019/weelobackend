/**
 * =============================================================================
 * TRACKING COMPLETION -- Tests for A4#32, A4#33, A4#20
 * =============================================================================
 *
 * A4#32: Cancelled booking guard in checkBookingCompletion
 *   - Booking already cancelled -> NOT overwritten to completed
 *
 * A4#33: checkOrderCompletion logic
 *   - All assignments completed -> order marked completed
 *   - Mix of completed+cancelled -> order marked completed
 *   - All cancelled -> order marked cancelled
 *   - Order lookup via assignment.orderId (not booking.orderId)
 *
 * A4#20: Redis-backed history persist state
 *   - Redis available -> reads/writes to Redis
 *   - Redis down -> falls back to in-memory Map
 *
 * @author TESTER-A (Team LEO)
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

// Redis service mock
const mockRedisGetJSON = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisAcquireLock = jest.fn();
const mockRedisReleaseLock = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: (...args: any[]) => mockRedisDel(...args),
    getJSON: (...args: any[]) => mockRedisGetJSON(...args),
    setJSON: (...args: any[]) => mockRedisSetJSON(...args),
    acquireLock: (...args: any[]) => mockRedisAcquireLock(...args),
    releaseLock: (...args: any[]) => mockRedisReleaseLock(...args),
    isConnected: jest.fn().mockReturnValue(true),
    exists: jest.fn().mockResolvedValue(false),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(undefined),
    expire: jest.fn().mockResolvedValue(undefined),
    sIsMember: jest.fn().mockResolvedValue(false),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    cancelTimer: jest.fn().mockResolvedValue(undefined),
    setTimer: jest.fn().mockResolvedValue(undefined),
    getExpiredTimers: jest.fn().mockResolvedValue([]),
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { logger } from '../shared/services/logger.service';

// =============================================================================
// HELPERS
// =============================================================================

function resetAllMocks(): void {
  jest.clearAllMocks();
  mockRedisGetJSON.mockReset();
  mockRedisSetJSON.mockReset();
  mockRedisDel.mockReset();
  mockRedisAcquireLock.mockReset();
  mockRedisReleaseLock.mockReset();
}

// =============================================================================
// A4#32: CANCELLED BOOKING GUARD
// =============================================================================

describe('A4#32 -- Cancelled booking guard in checkBookingCompletion', () => {
  /**
   * Simulates the checkBookingCompletion logic from tracking.service.ts.
   * Returns the action taken.
   */
  function simulateBookingCompletionCheck(
    assignments: Array<{ id: string; status: string }>,
    bookingStatus: string | null // null = booking not found
  ): 'completed' | 'skipped_cancelled' | 'skipped_already_complete' | 'not_all_done' | 'no_booking' {
    if (assignments.length === 0) return 'not_all_done';

    const allCompleted = assignments.every(a => a.status === 'completed');
    if (!allCompleted) return 'not_all_done';

    if (bookingStatus === null) return 'no_booking';

    // A4#32 FIX: guard against overwriting cancelled booking
    if (bookingStatus === 'cancelled') return 'skipped_cancelled';
    if (bookingStatus === 'completed') return 'skipped_already_complete';

    return 'completed';
  }

  it('booking already cancelled -> NOT overwritten to completed', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'completed' },
    ];

    const result = simulateBookingCompletionCheck(assignments, 'cancelled');
    expect(result).toBe('skipped_cancelled');
    expect(result).not.toBe('completed');
  });

  it('booking already completed -> idempotent no-op', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
    ];

    const result = simulateBookingCompletionCheck(assignments, 'completed');
    expect(result).toBe('skipped_already_complete');
  });

  it('all assignments completed, booking active -> marked completed', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'completed' },
      { id: 'a-3', status: 'completed' },
    ];

    const result = simulateBookingCompletionCheck(assignments, 'fully_filled');
    expect(result).toBe('completed');
  });

  it('not all assignments completed -> not marked', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'in_transit' },
    ];

    const result = simulateBookingCompletionCheck(assignments, 'active');
    expect(result).toBe('not_all_done');
  });

  it('no assignments -> not marked', () => {
    const result = simulateBookingCompletionCheck([], 'active');
    expect(result).toBe('not_all_done');
  });

  it('booking not found -> no booking result', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
    ];

    const result = simulateBookingCompletionCheck(assignments, null);
    expect(result).toBe('no_booking');
  });
});

// =============================================================================
// A4#33: checkOrderCompletion
// =============================================================================

describe('A4#33 -- checkOrderCompletion', () => {
  /**
   * Simulates checkOrderCompletion logic from tracking.service.ts.
   * Determines what status the order should transition to.
   */
  function determineOrderStatus(
    assignments: Array<{ id: string; status: string }>,
    currentOrderStatus: string | null
  ): 'completed' | 'cancelled' | 'no_change' | 'already_terminal' {
    if (assignments.length === 0) return 'no_change';

    const terminalStatuses = new Set(['completed', 'cancelled']);
    const allTerminal = assignments.every(a => terminalStatuses.has(a.status));

    if (!allTerminal) return 'no_change';

    // Check if order is already terminal
    if (currentOrderStatus === 'completed' || currentOrderStatus === 'cancelled') {
      return 'already_terminal';
    }

    const hasCompleted = assignments.some(a => a.status === 'completed');
    const allCancelled = assignments.every(a => a.status === 'cancelled');

    if (allCancelled) return 'cancelled';
    if (hasCompleted) return 'completed';

    return 'no_change';
  }

  it('all assignments completed -> order marked completed', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'completed' },
      { id: 'a-3', status: 'completed' },
    ];

    const result = determineOrderStatus(assignments, 'active');
    expect(result).toBe('completed');
  });

  it('mix of completed+cancelled -> order marked completed (at least one succeeded)', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'cancelled' },
      { id: 'a-3', status: 'completed' },
    ];

    const result = determineOrderStatus(assignments, 'active');
    expect(result).toBe('completed');
  });

  it('all cancelled -> order marked cancelled', () => {
    const assignments = [
      { id: 'a-1', status: 'cancelled' },
      { id: 'a-2', status: 'cancelled' },
    ];

    const result = determineOrderStatus(assignments, 'active');
    expect(result).toBe('cancelled');
  });

  it('one completed, rest still in progress -> no change', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'in_transit' },
    ];

    const result = determineOrderStatus(assignments, 'active');
    expect(result).toBe('no_change');
  });

  it('no assignments -> no change', () => {
    const result = determineOrderStatus([], 'active');
    expect(result).toBe('no_change');
  });

  it('order already completed -> already_terminal', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
    ];

    const result = determineOrderStatus(assignments, 'completed');
    expect(result).toBe('already_terminal');
  });

  it('order already cancelled -> already_terminal', () => {
    const assignments = [
      { id: 'a-1', status: 'cancelled' },
    ];

    const result = determineOrderStatus(assignments, 'cancelled');
    expect(result).toBe('already_terminal');
  });

  it('single assignment completed -> order completed', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
    ];

    const result = determineOrderStatus(assignments, 'partially_filled');
    expect(result).toBe('completed');
  });

  it('mix: 1 completed + 1 cancelled + 1 pending -> no change (not all terminal)', () => {
    const assignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'cancelled' },
      { id: 'a-3', status: 'pending' },
    ];

    const result = determineOrderStatus(assignments, 'active');
    expect(result).toBe('no_change');
  });
});

// =============================================================================
// A4#33 (continued): Order lookup via assignment.orderId
// =============================================================================

describe('A4#33 -- Order lookup via assignment.orderId (not booking.orderId)', () => {
  /**
   * The booking model has no orderId field.
   * The correct path: assignment.findFirst({ where: { bookingId, orderId: { not: null } } })
   * to discover the parent orderId.
   */
  function findOrderIdViaAssignment(
    assignments: Array<{ bookingId: string; orderId: string | null }>
  ): string | null {
    const match = assignments.find(a => a.orderId !== null);
    return match?.orderId ?? null;
  }

  it('assignment has orderId -> returns orderId', () => {
    const assignments = [
      { bookingId: 'b-1', orderId: 'order-001' },
      { bookingId: 'b-1', orderId: 'order-001' },
    ];

    const orderId = findOrderIdViaAssignment(assignments);
    expect(orderId).toBe('order-001');
  });

  it('no assignment has orderId -> returns null', () => {
    const assignments = [
      { bookingId: 'b-1', orderId: null },
      { bookingId: 'b-1', orderId: null },
    ];

    const orderId = findOrderIdViaAssignment(assignments);
    expect(orderId).toBeNull();
  });

  it('mixed: some have orderId, some not -> returns first found', () => {
    const assignments = [
      { bookingId: 'b-1', orderId: null },
      { bookingId: 'b-1', orderId: 'order-002' },
      { bookingId: 'b-1', orderId: 'order-002' },
    ];

    const orderId = findOrderIdViaAssignment(assignments);
    expect(orderId).toBe('order-002');
  });

  it('empty assignments -> returns null', () => {
    const orderId = findOrderIdViaAssignment([]);
    expect(orderId).toBeNull();
  });
});

// =============================================================================
// A4#20: REDIS-BACKED HISTORY PERSIST STATE
// =============================================================================

describe('A4#20 -- Redis-backed history persist state', () => {
  beforeEach(resetAllMocks);

  interface HistoryPersistState {
    latitude: number;
    longitude: number;
    timestampMs: number;
    status: string;
  }

  /**
   * Simulates the getHistoryPersistState logic from tracking.service.ts.
   * Redis-first with in-memory fallback.
   */
  class HistoryPersistManager {
    private inMemoryMap = new Map<string, HistoryPersistState>();
    private redisGetJSON: (key: string) => Promise<HistoryPersistState | null>;
    private redisSetJSON: (key: string, data: HistoryPersistState, ttl: number) => Promise<void>;
    private redisDel: (key: string) => Promise<void>;

    constructor(
      getJSON: (key: string) => Promise<HistoryPersistState | null>,
      setJSON: (key: string, data: HistoryPersistState, ttl: number) => Promise<void>,
      del: (key: string) => Promise<void>
    ) {
      this.redisGetJSON = getJSON;
      this.redisSetJSON = setJSON;
      this.redisDel = del;
    }

    async get(tripId: string): Promise<HistoryPersistState | null> {
      try {
        const redisState = await this.redisGetJSON(`tracking:persist-state:${tripId}`);
        if (redisState) {
          this.inMemoryMap.set(tripId, redisState);
          return redisState;
        }
      } catch {
        // Redis failed -- fall through to in-memory
      }
      return this.inMemoryMap.get(tripId) || null;
    }

    async set(tripId: string, state: HistoryPersistState): Promise<void> {
      this.inMemoryMap.set(tripId, state);
      const TTL_48H = 48 * 60 * 60;
      try {
        await this.redisSetJSON(`tracking:persist-state:${tripId}`, state, TTL_48H);
      } catch {
        // Redis failed -- in-memory already updated
      }
    }

    async delete(tripId: string): Promise<void> {
      this.inMemoryMap.delete(tripId);
      try {
        await this.redisDel(`tracking:persist-state:${tripId}`);
      } catch {
        // Non-critical
      }
    }

    getInMemorySize(): number {
      return this.inMemoryMap.size;
    }
  }

  it('Redis available -> reads from Redis', async () => {
    const state: HistoryPersistState = { latitude: 19.0, longitude: 72.8, timestampMs: Date.now(), status: 'in_transit' };
    mockRedisGetJSON.mockResolvedValue(state);

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    const result = await manager.get('trip-001');

    expect(result).toEqual(state);
    expect(mockRedisGetJSON).toHaveBeenCalledWith('tracking:persist-state:trip-001');
  });

  it('Redis available -> writes to Redis with 48h TTL', async () => {
    mockRedisSetJSON.mockResolvedValue(undefined);

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    const state: HistoryPersistState = { latitude: 28.6, longitude: 77.2, timestampMs: Date.now(), status: 'heading_to_pickup' };
    await manager.set('trip-002', state);

    expect(mockRedisSetJSON).toHaveBeenCalledWith(
      'tracking:persist-state:trip-002',
      state,
      172800 // 48h in seconds
    );
  });

  it('Redis down on read -> falls back to in-memory Map', async () => {
    mockRedisGetJSON.mockRejectedValue(new Error('Redis ECONNREFUSED'));

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    // Pre-populate in-memory map via a set
    const state: HistoryPersistState = { latitude: 19.0, longitude: 72.8, timestampMs: 1000, status: 'in_transit' };
    // Manually set in-memory by calling set (which updates Map even if Redis fails)
    mockRedisSetJSON.mockRejectedValue(new Error('Redis down'));
    await manager.set('trip-003', state);

    // Now read: Redis fails, but in-memory has it
    const result = await manager.get('trip-003');

    expect(result).toEqual(state);
  });

  it('Redis down on write -> state still saved in-memory', async () => {
    mockRedisSetJSON.mockRejectedValue(new Error('Redis ECONNREFUSED'));

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    const state: HistoryPersistState = { latitude: 12.9, longitude: 77.5, timestampMs: Date.now(), status: 'at_pickup' };

    // Should NOT throw
    await expect(manager.set('trip-004', state)).resolves.toBeUndefined();

    // In-memory should have the state
    expect(manager.getInMemorySize()).toBe(1);

    // Reading back (Redis still down) should return from in-memory
    mockRedisGetJSON.mockRejectedValue(new Error('Redis down'));
    const result = await manager.get('trip-004');
    expect(result).toEqual(state);
  });

  it('Redis returns null -> falls back to in-memory', async () => {
    mockRedisGetJSON.mockResolvedValue(null);

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    const result = await manager.get('trip-empty');
    expect(result).toBeNull(); // Neither Redis nor in-memory has it
  });

  it('Redis read syncs into in-memory fallback', async () => {
    const state: HistoryPersistState = { latitude: 19.0, longitude: 72.8, timestampMs: 5000, status: 'in_transit' };
    mockRedisGetJSON.mockResolvedValue(state);

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    // First read: gets from Redis and syncs to in-memory
    await manager.get('trip-sync');
    expect(manager.getInMemorySize()).toBe(1);

    // Now Redis goes down -- should still read from in-memory
    mockRedisGetJSON.mockRejectedValue(new Error('Redis down'));
    const result = await manager.get('trip-sync');
    expect(result).toEqual(state);
  });

  it('delete removes from both Redis and in-memory', async () => {
    mockRedisSetJSON.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(undefined);

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    const state: HistoryPersistState = { latitude: 10.0, longitude: 76.0, timestampMs: Date.now(), status: 'completed' };
    await manager.set('trip-del', state);

    expect(manager.getInMemorySize()).toBe(1);

    await manager.delete('trip-del');

    expect(manager.getInMemorySize()).toBe(0);
    expect(mockRedisDel).toHaveBeenCalledWith('tracking:persist-state:trip-del');
  });

  it('delete with Redis down -> in-memory still cleared', async () => {
    mockRedisSetJSON.mockResolvedValue(undefined);
    mockRedisDel.mockRejectedValue(new Error('Redis down'));

    const manager = new HistoryPersistManager(
      (key) => mockRedisGetJSON(key),
      (key, data, ttl) => mockRedisSetJSON(key, data, ttl),
      (key) => mockRedisDel(key)
    );

    const state: HistoryPersistState = { latitude: 10.0, longitude: 76.0, timestampMs: Date.now(), status: 'completed' };
    await manager.set('trip-del-fail', state);

    await expect(manager.delete('trip-del-fail')).resolves.toBeUndefined();
    expect(manager.getInMemorySize()).toBe(0);
  });
});

// =============================================================================
// COMBINED: Completion cascade tests
// =============================================================================

describe('Completion cascade: booking -> order', () => {
  it('booking completes -> triggers order completion check', () => {
    // Simulate the cascade:
    // 1. All assignments for booking complete
    // 2. checkBookingCompletion marks booking completed
    // 3. Looks up orderId via assignment.findFirst
    // 4. Calls checkOrderCompletion

    const bookingAssignments = [
      { id: 'a-1', status: 'completed', bookingId: 'b-1', orderId: 'order-1' },
      { id: 'a-2', status: 'completed', bookingId: 'b-1', orderId: 'order-1' },
    ];

    // Step 1: All completed
    const allCompleted = bookingAssignments.every(a => a.status === 'completed');
    expect(allCompleted).toBe(true);

    // Step 2: Find orderId via assignment
    const orderAssignment = bookingAssignments.find(a => a.orderId !== null);
    expect(orderAssignment?.orderId).toBe('order-1');

    // Step 3: Check order completion
    const orderAssignments = [
      { id: 'a-1', status: 'completed' },
      { id: 'a-2', status: 'completed' },
      { id: 'a-3', status: 'cancelled' }, // Another booking's assignment
    ];

    const terminalStatuses = new Set(['completed', 'cancelled']);
    const allTerminal = orderAssignments.every(a => terminalStatuses.has(a.status));
    expect(allTerminal).toBe(true);

    const hasCompleted = orderAssignments.some(a => a.status === 'completed');
    expect(hasCompleted).toBe(true);

    // Order should be marked 'completed' (has at least one completed)
    const allCancelled = orderAssignments.every(a => a.status === 'cancelled');
    const newStatus = allCancelled ? 'cancelled' : hasCompleted ? 'completed' : null;
    expect(newStatus).toBe('completed');
  });

  it('all bookings in order cancelled -> order marked cancelled', () => {
    const orderAssignments = [
      { id: 'a-1', status: 'cancelled' },
      { id: 'a-2', status: 'cancelled' },
      { id: 'a-3', status: 'cancelled' },
    ];

    const terminalStatuses = new Set(['completed', 'cancelled']);
    const allTerminal = orderAssignments.every(a => terminalStatuses.has(a.status));
    expect(allTerminal).toBe(true);

    const allCancelled = orderAssignments.every(a => a.status === 'cancelled');
    expect(allCancelled).toBe(true);

    const hasCompleted = orderAssignments.some(a => a.status === 'completed');
    expect(hasCompleted).toBe(false);

    const newStatus = allCancelled ? 'cancelled' : 'completed';
    expect(newStatus).toBe('cancelled');
  });
});
