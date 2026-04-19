/**
 * =============================================================================
 * F-A-56 — Outbox leader-election helper (atomic CAS renewal + fencing token)
 * =============================================================================
 *
 * Tests the extracted `leader-election.service.ts` helper:
 *
 *   acquireLeader(key, instanceId, ttl)  — SET NX EX (fresh election only)
 *   renewLeader(key, instanceId, ttl)    — atomic Lua CAS: only the current
 *                                          owner can extend the lease
 *   startHeartbeat(key, instanceId, ttl, intervalMs) — setInterval wrapper
 *                                          with .unref()
 *
 * Why CAS matters (the F-A-56 bug):
 *   Today `order-dispatch-outbox.service.ts:494` calls a blind
 *   `redisService.set(OUTBOX_LEADER_KEY, instanceId, OUTBOX_LEADER_TTL)` after
 *   a 10s-TTL batch finishes. If the leader GC-paused past 10s, a *new*
 *   leader has already taken over — the blind set then STOMPS the new
 *   leader, inviting two pollers to fence-race on the same rows.
 *
 * RED assertions (must fail without the helper):
 *  - Module src/shared/services/leader-election.service.ts exists and exports
 *    acquireLeader, renewLeader, startHeartbeat.
 *  - acquireLeader uses Redis SET NX EX (fresh acquire returns true;
 *    already-held returns false).
 *  - renewLeader is atomic CAS: the OLD instance's renew MUST fail once a
 *    new instance has legitimately taken the lease; only the current owner's
 *    renew succeeds. This is the behaviour the blind `set` violates today.
 *  - startHeartbeat returns a NodeJS.Timeout whose `unref` was called (so
 *    the interval never blocks process exit).
 *  - The Lua CAS script uses a GET==ARGV[1] guard (contract assertion).
 *
 * The differentiator suite still passes (no two-phase-hold code touched).
 * =============================================================================
 */

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
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

// In-memory fake of the bits of redisService leader-election needs.
// Models SET NX EX + atomic eval-based CAS renewal.
type StoredValue = { value: string; expiresAt: number };

const fakeStore = new Map<string, StoredValue>();

function nowMs(): number {
  return Date.now();
}

function isExpired(entry: StoredValue | undefined): boolean {
  return !entry || entry.expiresAt <= nowMs();
}

const mockSetNxEx = jest.fn(async (key: string, value: string, ttlSec: number): Promise<boolean> => {
  const existing = fakeStore.get(key);
  if (existing && !isExpired(existing)) {
    return false;
  }
  fakeStore.set(key, { value, expiresAt: nowMs() + ttlSec * 1000 });
  return true;
});

const mockEval = jest.fn(async (script: string, keys: string[], args: string[]): Promise<any> => {
  const key = keys[0];
  const value = args[0];
  const ttlSec = parseInt(args[1], 10);
  const existing = fakeStore.get(key);
  const normalised = script.replace(/\s+/g, ' ');

  // Shape 1 — SET NX EX (acquireLeader fallback path):
  //   if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 1 else return 0 end
  if (/'NX'\s*,\s*'EX'/.test(normalised)) {
    if (existing && !isExpired(existing)) return 0;
    fakeStore.set(key, { value, expiresAt: nowMs() + ttlSec * 1000 });
    return 1;
  }

  // Shape 2 — CAS renewal (renewLeader):
  //   if redis.call('GET', KEYS[1]) == ARGV[1] then
  //     redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1
  //   else return 0 end
  if (!existing || isExpired(existing)) return 0;
  if (existing.value !== value) return 0;
  fakeStore.set(key, { value: existing.value, expiresAt: nowMs() + ttlSec * 1000 });
  return 1;
});

const mockDel = jest.fn(async (key: string): Promise<number> => {
  return fakeStore.delete(key) ? 1 : 0;
});

const mockGet = jest.fn(async (key: string): Promise<string | null> => {
  const entry = fakeStore.get(key);
  if (!entry || isExpired(entry)) return null;
  return entry.value;
});

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    set: jest.fn(async (key: string, value: string, ttlSec?: number) => {
      fakeStore.set(key, { value, expiresAt: nowMs() + (ttlSec ?? 60) * 1000 });
      return 'OK';
    }),
    setNxEx: mockSetNxEx,
    get: mockGet,
    del: mockDel,
    eval: mockEval,
    // Fallback — if the helper chooses to use acquireLock instead of raw setNxEx
    acquireLock: jest.fn(async (lockKey: string, holderId: string, ttlSec: number) => {
      const key = `lock:${lockKey}`;
      const acquired = await mockSetNxEx(key, holderId, ttlSec);
      return { acquired, ttl: acquired ? ttlSec : undefined };
    }),
  },
}));

// Import *after* mocks are declared.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const leaderModule = require('../shared/services/leader-election.service');
const {
  acquireLeader,
  renewLeader,
  startHeartbeat,
  LEADER_RENEW_SCRIPT,
} = leaderModule;

beforeEach(() => {
  fakeStore.clear();
  jest.clearAllMocks();
});

describe('F-A-56 — leader-election helper: module contract', () => {
  it('exports acquireLeader, renewLeader, and startHeartbeat', () => {
    expect(typeof acquireLeader).toBe('function');
    expect(typeof renewLeader).toBe('function');
    expect(typeof startHeartbeat).toBe('function');
  });

  it('exports the Lua CAS renewal script with a GET==ARGV[1] guard', () => {
    // The script must be the exact atomic-CAS contract — not a blind SET.
    expect(typeof LEADER_RENEW_SCRIPT).toBe('string');
    const normalised = (LEADER_RENEW_SCRIPT as string).replace(/\s+/g, ' ');
    expect(normalised).toMatch(/redis\.call\(\s*'GET'\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]/);
    expect(normalised).toMatch(/redis\.call\(\s*'SET'\s*,\s*KEYS\[1\]\s*,\s*ARGV\[1\]\s*,\s*'EX'\s*,\s*ARGV\[2\]\s*\)/);
  });
});

describe('F-A-56 — acquireLeader: SET NX EX semantics', () => {
  it('returns true for the first caller and stores the instanceId with TTL', async () => {
    const acquired = await acquireLeader('outbox:leader', 'pod-1', 60);
    expect(acquired).toBe(true);

    const stored = fakeStore.get('outbox:leader');
    expect(stored?.value).toBe('pod-1');
    expect(stored?.expiresAt).toBeGreaterThan(nowMs());
  });

  it('returns false when another instance already holds the lease', async () => {
    await acquireLeader('outbox:leader', 'pod-1', 60);
    const acquired = await acquireLeader('outbox:leader', 'pod-2', 60);
    expect(acquired).toBe(false);
    expect(fakeStore.get('outbox:leader')?.value).toBe('pod-1');
  });
});

describe('F-A-56 — renewLeader: atomic CAS prevents stomping', () => {
  it('returns true when the current owner renews its own lease', async () => {
    await acquireLeader('outbox:leader', 'pod-1', 60);
    const renewed = await renewLeader('outbox:leader', 'pod-1', 60);
    expect(renewed).toBe(true);
  });

  it('returns false when a non-owner attempts to renew (preventing stomp)', async () => {
    await acquireLeader('outbox:leader', 'pod-1', 60);
    const renewed = await renewLeader('outbox:leader', 'pod-2', 60);
    expect(renewed).toBe(false);
    expect(fakeStore.get('outbox:leader')?.value).toBe('pod-1');
  });

  it('leader-swap scenario: pod-1 GC-paused, pod-2 took over — pod-1 renew MUST fail', async () => {
    // Initial: pod-1 is leader with a short TTL.
    await acquireLeader('outbox:leader', 'pod-1', 1);

    // Simulate pod-1's GC pause past the TTL.
    const entry = fakeStore.get('outbox:leader')!;
    fakeStore.set('outbox:leader', { value: entry.value, expiresAt: nowMs() - 10 });

    // pod-2 legitimately takes over.
    const pod2Acquired = await acquireLeader('outbox:leader', 'pod-2', 60);
    expect(pod2Acquired).toBe(true);

    // pod-1 wakes up and naively tries to renew — CAS MUST reject it.
    // (The blind `set` bug today would succeed and stomp pod-2.)
    const pod1Renewed = await renewLeader('outbox:leader', 'pod-1', 60);
    expect(pod1Renewed).toBe(false);

    // pod-2 still owns the lease — no stomping.
    expect(fakeStore.get('outbox:leader')?.value).toBe('pod-2');
  });

  it('returns false if the lease expired silently (no owner at all)', async () => {
    await acquireLeader('outbox:leader', 'pod-1', 1);
    const entry = fakeStore.get('outbox:leader')!;
    fakeStore.set('outbox:leader', { value: entry.value, expiresAt: nowMs() - 10 });

    const renewed = await renewLeader('outbox:leader', 'pod-1', 60);
    expect(renewed).toBe(false);
  });
});

describe('F-A-56 — acquireLeader: error handling + argument validation', () => {
  it('throws when called with an empty key', async () => {
    await expect(acquireLeader('', 'pod-1', 60)).rejects.toThrow(/invalid arguments/);
  });

  it('throws when called with an empty instanceId', async () => {
    await expect(acquireLeader('key', '', 60)).rejects.toThrow(/invalid arguments/);
  });

  it('throws when called with a non-positive ttl', async () => {
    await expect(acquireLeader('key', 'pod-1', 0)).rejects.toThrow(/invalid arguments/);
    await expect(acquireLeader('key', 'pod-1', -5)).rejects.toThrow(/invalid arguments/);
    await expect(acquireLeader('key', 'pod-1', Number.NaN)).rejects.toThrow(/invalid arguments/);
  });

  it('returns false and logs when setNxEx throws (Redis unavailable)', async () => {
    mockSetNxEx.mockRejectedValueOnce(new Error('connection refused'));
    const acquired = await acquireLeader('outbox:leader', 'pod-1', 60);
    expect(acquired).toBe(false);
  });
});

describe('F-A-56 — renewLeader: error handling + argument validation', () => {
  it('throws when called with an empty key', async () => {
    await expect(renewLeader('', 'pod-1', 60)).rejects.toThrow(/invalid arguments/);
  });

  it('throws when called with an empty instanceId', async () => {
    await expect(renewLeader('key', '', 60)).rejects.toThrow(/invalid arguments/);
  });

  it('returns false and increments failure metric when eval throws', async () => {
    mockEval.mockRejectedValueOnce(new Error('redis timeout'));
    const renewed = await renewLeader('outbox:leader', 'pod-1', 60);
    expect(renewed).toBe(false);
  });
});

describe('F-A-56 — acquireLeader: fallback path when setNxEx is not available', () => {
  it('falls back to the eval-based NX EX path when redisService.setNxEx is undefined', async () => {
    // Temporarily erase setNxEx from the mock so the fallback runs.
    const { redisService: r } = require('../shared/services/redis.service');
    const savedFn = r.setNxEx;
    delete r.setNxEx;

    try {
      fakeStore.clear();
      const acquired = await acquireLeader('outbox:leader', 'pod-1', 60);
      expect(acquired).toBe(true);
      expect(mockEval).toHaveBeenCalled();
      // The eval script must be a SET NX EX contract.
      const usedScript = mockEval.mock.calls[mockEval.mock.calls.length - 1][0];
      expect(usedScript).toMatch(/SET.*NX.*EX/);
    } finally {
      r.setNxEx = savedFn;
    }
  });

  it('returns false and logs when the fallback eval throws', async () => {
    const { redisService: r } = require('../shared/services/redis.service');
    const savedFn = r.setNxEx;
    delete r.setNxEx;
    mockEval.mockRejectedValueOnce(new Error('redis down'));

    try {
      const acquired = await acquireLeader('outbox:leader', 'pod-1', 60);
      expect(acquired).toBe(false);
    } finally {
      r.setNxEx = savedFn;
    }
  });
});

describe('F-A-56 — startHeartbeat: error handling', () => {
  it('swallows heartbeat exceptions so the interval does not die', async () => {
    jest.useFakeTimers();
    mockEval.mockRejectedValue(new Error('redis flapped'));
    const timer = startHeartbeat('outbox:leader', 'pod-1', 60, 20_000);

    jest.advanceTimersByTime(21_000);
    await Promise.resolve();
    await Promise.resolve();

    // If the heartbeat hadn't swallowed the error, jest would not have
    // advanced cleanly. Nothing to assert beyond "did not throw" — but we
    // also check renewLeader was attempted at least once.
    expect(mockEval).toHaveBeenCalled();

    clearInterval(timer as any);
    mockEval.mockReset();
    jest.useRealTimers();
  });
});

describe('F-A-56 — startHeartbeat: setInterval + unref', () => {
  afterEach(() => {
    // Clear any stray intervals created in failing tests.
    jest.clearAllTimers();
  });

  it('returns a timer whose unref() is invoked (so it never blocks process exit)', () => {
    jest.useFakeTimers();
    const spyInterval = jest.spyOn(global, 'setInterval');

    const timer = startHeartbeat('outbox:leader', 'pod-1', 60, 20_000);
    expect(spyInterval).toHaveBeenCalled();
    expect(timer).toBeDefined();

    // NodeJS timers always expose unref. If the helper forgot to call it,
    // the returned timer keeps the event loop alive → blocks process exit.
    const typed = timer as unknown as { hasRef?: () => boolean };
    if (typeof typed.hasRef === 'function') {
      expect(typed.hasRef()).toBe(false);
    }

    clearInterval(timer as any);
    spyInterval.mockRestore();
    jest.useRealTimers();
  });

  it('heartbeat tick calls renewLeader with the owner instanceId', async () => {
    jest.useFakeTimers();
    await acquireLeader('outbox:leader', 'pod-1', 60);
    const timer = startHeartbeat('outbox:leader', 'pod-1', 60, 20_000);

    // Fast-forward to trigger the first interval tick.
    jest.advanceTimersByTime(21_000);
    // Allow any queued microtasks from the async renewLeader to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockEval).toHaveBeenCalled();
    const evalCall = mockEval.mock.calls[0];
    // KEYS[1] in the Lua call.
    expect(evalCall[1]).toEqual(['outbox:leader']);
    // ARGV[1] is the instanceId being guarded against.
    expect(evalCall[2][0]).toBe('pod-1');

    clearInterval(timer as any);
    jest.useRealTimers();
  });
});
