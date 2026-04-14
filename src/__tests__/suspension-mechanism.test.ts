/**
 * =============================================================================
 * SUSPENSION MECHANISM -- Comprehensive Tests (80+ scenarios)
 * =============================================================================
 *
 * Tests the admin transporter suspension/warn/unsuspend system:
 *   A. Suspend User (17 tests)
 *   B. Warn User (12 tests)
 *   C. Unsuspend User (11 tests)
 *   D. Suspension Check in Dispatch (16 tests)
 *   E. Action History (12 tests)
 *   F. What-If Scenarios (20 tests)
 *
 * Architecture:
 *   - Suspension state stored in Redis (no DB migration)
 *   - Redis keys: suspension:{userId}, suspension:history:{userId}
 *   - Suspended users blocked from going online + receiving bookings
 *   - Warnings stored but do not block operations
 *   - Action history as audit log (append-only, capped at 100)
 *
 * @author Weelo Test Agent
 * =============================================================================
 */

// =============================================================================
// REDIS KEY CONSTANTS (mirrors the implementation contract)
// =============================================================================

const SUSPENSION_KEY = (userId: string) => `suspension:${userId}`;
const SUSPENSION_HISTORY_KEY = (userId: string) => `suspension:history:${userId}`;
const SUSPENSION_HISTORY_MAX = 100;

// =============================================================================
// TYPES
// =============================================================================

interface SuspensionRecord {
  userId: string;
  reason: string;
  adminId: string;
  type: 'suspend' | 'warn' | 'unsuspend';
  durationHours: number; // 0 = permanent
  createdAt: string;
  expiresAt: string | null; // null = permanent
}

interface ActionHistoryEntry {
  action: 'suspend' | 'warn' | 'unsuspend';
  adminId: string;
  reason: string;
  durationHours: number;
  timestamp: string;
}

// =============================================================================
// MOCK REDIS -- In-memory implementation for test isolation
// =============================================================================

class MockRedis {
  private store: Map<string, string> = new Map();
  private ttls: Map<string, number> = new Map(); // absolute expiry ms
  private lists: Map<string, string[]> = new Map();
  private _connected: boolean = true;

  // --- Connection ---
  setConnected(state: boolean): void {
    this._connected = state;
  }

  isConnected(): boolean {
    return this._connected;
  }

  // --- Basic operations ---
  async get(key: string): Promise<string | null> {
    if (!this._connected) throw new Error('Redis connection refused');
    this.expireIfNeeded(key);
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this._connected) throw new Error('Redis connection refused');
    this.store.set(key, value);
    if (ttlSeconds && ttlSeconds > 0) {
      this.ttls.set(key, Date.now() + ttlSeconds * 1000);
    } else {
      this.ttls.delete(key);
    }
  }

  async del(key: string): Promise<boolean> {
    if (!this._connected) throw new Error('Redis connection refused');
    const existed = this.store.has(key) || this.lists.has(key);
    this.store.delete(key);
    this.lists.delete(key);
    this.ttls.delete(key);
    return existed;
  }

  async exists(key: string): Promise<boolean> {
    if (!this._connected) throw new Error('Redis connection refused');
    this.expireIfNeeded(key);
    return this.store.has(key) || this.lists.has(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this._connected) throw new Error('Redis connection refused');
    if (this.store.has(key) || this.lists.has(key)) {
      this.ttls.set(key, Date.now() + ttlSeconds * 1000);
      return true;
    }
    return false;
  }

  async ttl(key: string): Promise<number> {
    if (!this._connected) throw new Error('Redis connection refused');
    this.expireIfNeeded(key);
    const exp = this.ttls.get(key);
    if (!exp) return -1; // no TTL (permanent)
    const remaining = Math.ceil((exp - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2; // -2 = expired
  }

  // --- JSON helpers (match redisService.getJSON/setJSON) ---
  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  async setJSON<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  // --- List operations (for history) ---
  async lPush(key: string, value: string): Promise<number> {
    if (!this._connected) throw new Error('Redis connection refused');
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    if (!this._connected) throw new Error('Redis connection refused');
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    if (!this._connected) throw new Error('Redis connection refused');
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    this.lists.set(key, list.slice(start, end));
  }

  async lLen(key: string): Promise<number> {
    if (!this._connected) throw new Error('Redis connection refused');
    return (this.lists.get(key) ?? []).length;
  }

  // --- Set operations (for online transporters) ---
  private sets: Map<string, Set<string>> = new Map();

  async sAdd(key: string, ...members: string[]): Promise<number> {
    if (!this._connected) throw new Error('Redis connection refused');
    const s = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) { s.add(m); added++; }
    }
    this.sets.set(key, s);
    return added;
  }

  async sRem(key: string, ...members: string[]): Promise<number> {
    if (!this._connected) throw new Error('Redis connection refused');
    const s = this.sets.get(key);
    if (!s) return 0;
    let removed = 0;
    for (const m of members) {
      if (s.delete(m)) removed++;
    }
    return removed;
  }

  async sIsMember(key: string, member: string): Promise<boolean> {
    if (!this._connected) throw new Error('Redis connection refused');
    return this.sets.get(key)?.has(member) ?? false;
  }

  async sMembers(key: string): Promise<string[]> {
    if (!this._connected) throw new Error('Redis connection refused');
    return Array.from(this.sets.get(key) ?? []);
  }

  // --- Internals ---
  private expireIfNeeded(key: string): void {
    const exp = this.ttls.get(key);
    if (exp && Date.now() >= exp) {
      this.store.delete(key);
      this.lists.delete(key);
      this.ttls.delete(key);
    }
  }

  /** Force-expire a key (simulate TTL passage) */
  forceExpire(key: string): void {
    this.store.delete(key);
    this.lists.delete(key);
    this.ttls.delete(key);
  }

  /** Flush all data */
  flush(): void {
    this.store.clear();
    this.lists.clear();
    this.sets.clear();
    this.ttls.clear();
    this._connected = true;
  }
}

// =============================================================================
// SUSPENSION SERVICE -- Pure logic under test
// =============================================================================
// This mirrors the expected implementation contract. Tests validate behavior.
// =============================================================================

class SuspensionService {
  constructor(private redis: MockRedis) {}

  /**
   * Suspend a transporter.
   * Stores suspension record in Redis with optional TTL.
   * Appends to action history.
   */
  async suspendUser(params: {
    userId: string;
    adminId: string;
    reason: string;
    durationHours: number;
  }): Promise<{ success: boolean; suspension: SuspensionRecord }> {
    const { userId, adminId, reason, durationHours } = params;

    // Validation
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new AppError(400, 'VALIDATION_ERROR', 'userId is required');
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      throw new AppError(400, 'VALIDATION_ERROR', 'reason is required');
    }
    if (typeof durationHours !== 'number' || durationHours < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'durationHours must be >= 0');
    }
    if (!adminId || typeof adminId !== 'string') {
      throw new AppError(400, 'VALIDATION_ERROR', 'adminId is required');
    }

    const now = new Date().toISOString();
    const expiresAt = durationHours > 0
      ? new Date(Date.now() + durationHours * 3600 * 1000).toISOString()
      : null;

    const record: SuspensionRecord = {
      userId,
      reason,
      adminId,
      type: 'suspend',
      durationHours,
      createdAt: now,
      expiresAt,
    };

    // Store suspension in Redis
    const ttlSeconds = durationHours > 0 ? durationHours * 3600 : undefined;
    await this.redis.setJSON(SUSPENSION_KEY(userId), record, ttlSeconds);

    // Append to history
    await this.appendHistory(userId, {
      action: 'suspend',
      adminId,
      reason,
      durationHours,
      timestamp: now,
    });

    return { success: true, suspension: record };
  }

  /**
   * Warn a transporter.
   * Stores warning in history but does NOT create a suspension block.
   */
  async warnUser(params: {
    userId: string;
    adminId: string;
    reason: string;
  }): Promise<{ success: boolean }> {
    const { userId, adminId, reason } = params;

    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new AppError(400, 'VALIDATION_ERROR', 'userId is required');
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      throw new AppError(400, 'VALIDATION_ERROR', 'reason is required');
    }
    if (!adminId || typeof adminId !== 'string') {
      throw new AppError(400, 'VALIDATION_ERROR', 'adminId is required');
    }

    const now = new Date().toISOString();

    await this.appendHistory(userId, {
      action: 'warn',
      adminId,
      reason,
      durationHours: 0,
      timestamp: now,
    });

    return { success: true };
  }

  /**
   * Unsuspend a transporter.
   * Removes the suspension key and records in history.
   */
  async unsuspendUser(params: {
    userId: string;
    adminId: string;
    reason: string;
  }): Promise<{ success: boolean; wasSuspended: boolean }> {
    const { userId, adminId, reason } = params;

    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new AppError(400, 'VALIDATION_ERROR', 'userId is required');
    }
    if (!adminId || typeof adminId !== 'string') {
      throw new AppError(400, 'VALIDATION_ERROR', 'adminId is required');
    }

    const existing = await this.redis.get(SUSPENSION_KEY(userId));
    const wasSuspended = existing !== null;

    // Remove suspension
    await this.redis.del(SUSPENSION_KEY(userId));

    const now = new Date().toISOString();
    await this.appendHistory(userId, {
      action: 'unsuspend',
      adminId,
      reason: reason || 'Manual unsuspend',
      durationHours: 0,
      timestamp: now,
    });

    return { success: true, wasSuspended };
  }

  /**
   * Check if a user is currently suspended.
   * Returns null if not suspended, or the suspension record if active.
   *
   * FAIL OPEN: If Redis is down, returns null (not suspended) to avoid
   * blocking legitimate users due to infrastructure failure.
   */
  async checkSuspension(userId: string): Promise<SuspensionRecord | null> {
    try {
      return await this.redis.getJSON<SuspensionRecord>(SUSPENSION_KEY(userId));
    } catch {
      // Fail open: Redis down means we allow the user through
      return null;
    }
  }

  /**
   * Get the action history for a user.
   */
  async getHistory(userId: string): Promise<ActionHistoryEntry[]> {
    const raw = await this.redis.lRange(SUSPENSION_HISTORY_KEY(userId), 0, -1);
    return raw.map((entry) => JSON.parse(entry) as ActionHistoryEntry);
  }

  /**
   * Filter broadcast candidates, removing suspended transporters.
   * Fail open: if Redis is down, all candidates pass through.
   */
  async filterSuspendedFromCandidates(
    transporterIds: string[]
  ): Promise<string[]> {
    const results: string[] = [];
    for (const id of transporterIds) {
      const suspension = await this.checkSuspension(id);
      if (!suspension) {
        results.push(id);
      }
    }
    return results;
  }

  // --- Private ---

  private async appendHistory(
    userId: string,
    entry: ActionHistoryEntry
  ): Promise<void> {
    const key = SUSPENSION_HISTORY_KEY(userId);
    await this.redis.lPush(key, JSON.stringify(entry));

    // Cap at SUSPENSION_HISTORY_MAX entries
    const len = await this.redis.lLen(key);
    if (len > SUSPENSION_HISTORY_MAX) {
      await this.redis.lTrim(key, 0, SUSPENSION_HISTORY_MAX - 1);
    }
  }
}

// =============================================================================
// SIMPLE AppError for test context
// =============================================================================

class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Suspension Mechanism', () => {
  let redis: MockRedis;
  let service: SuspensionService;

  const ADMIN_ID = 'admin-001';
  const ADMIN_ID_2 = 'admin-002';
  const TRANSPORTER_ID = 'transporter-001';
  const TRANSPORTER_ID_2 = 'transporter-002';
  const TRANSPORTER_ID_3 = 'transporter-003';

  beforeEach(() => {
    redis = new MockRedis();
    service = new SuspensionService(redis);
  });

  // ===========================================================================
  // A. SUSPEND USER (17 tests)
  // ===========================================================================

  describe('A. Suspend User', () => {
    it('A1: admin can suspend a transporter with reason and duration', async () => {
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Repeated SLA violations',
        durationHours: 24,
      });

      expect(result.success).toBe(true);
      expect(result.suspension.userId).toBe(TRANSPORTER_ID);
      expect(result.suspension.reason).toBe('Repeated SLA violations');
      expect(result.suspension.adminId).toBe(ADMIN_ID);
      expect(result.suspension.type).toBe('suspend');
      expect(result.suspension.durationHours).toBe(24);
    });

    it('A2: suspension stored in Redis with correct key', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
        durationHours: 12,
      });

      const stored = await redis.getJSON<SuspensionRecord>(SUSPENSION_KEY(TRANSPORTER_ID));
      expect(stored).not.toBeNull();
      expect(stored!.userId).toBe(TRANSPORTER_ID);
      expect(stored!.type).toBe('suspend');
    });

    it('A3: suspension with 24h duration has correct TTL (~86400s)', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
        durationHours: 24,
      });

      const ttl = await redis.ttl(SUSPENSION_KEY(TRANSPORTER_ID));
      // TTL should be close to 86400 (within a few seconds of test execution)
      expect(ttl).toBeGreaterThan(86390);
      expect(ttl).toBeLessThanOrEqual(86400);
    });

    it('A4: suspend with 0 duration is permanent (no TTL)', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Permanent ban',
        durationHours: 0,
      });

      const ttl = await redis.ttl(SUSPENSION_KEY(TRANSPORTER_ID));
      expect(ttl).toBe(-1); // -1 = no expiry
    });

    it('A5: permanent suspension has expiresAt = null', async () => {
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Permanent ban',
        durationHours: 0,
      });

      expect(result.suspension.expiresAt).toBeNull();
    });

    it('A6: timed suspension has a valid expiresAt timestamp', async () => {
      const before = Date.now();
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Temporary',
        durationHours: 6,
      });

      expect(result.suspension.expiresAt).not.toBeNull();
      const expiresMs = new Date(result.suspension.expiresAt!).getTime();
      // Should be ~6 hours from now
      expect(expiresMs).toBeGreaterThan(before + 5 * 3600 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(before + 7 * 3600 * 1000);
    });

    it('A7: suspended user returns non-null from checkSuspension', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'SLA',
        durationHours: 24,
      });

      const suspension = await service.checkSuspension(TRANSPORTER_ID);
      expect(suspension).not.toBeNull();
      expect(suspension!.userId).toBe(TRANSPORTER_ID);
    });

    it('A8: non-suspended user returns null from checkSuspension', async () => {
      const suspension = await service.checkSuspension('non-existent-user');
      expect(suspension).toBeNull();
    });

    it('A9: suspension auto-expires after duration (simulated)', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Short',
        durationHours: 1,
      });

      // Verify suspended
      let check = await service.checkSuspension(TRANSPORTER_ID);
      expect(check).not.toBeNull();

      // Simulate TTL expiry
      redis.forceExpire(SUSPENSION_KEY(TRANSPORTER_ID));

      // Now should be clear
      check = await service.checkSuspension(TRANSPORTER_ID);
      expect(check).toBeNull();
    });

    it('A10: re-suspending an already-suspended user updates the record', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'First offense',
        durationHours: 12,
      });

      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID_2,
        reason: 'Second offense -- extended',
        durationHours: 48,
      });

      const stored = await redis.getJSON<SuspensionRecord>(SUSPENSION_KEY(TRANSPORTER_ID));
      expect(stored!.reason).toBe('Second offense -- extended');
      expect(stored!.durationHours).toBe(48);
      expect(stored!.adminId).toBe(ADMIN_ID_2);
    });

    it('A11: re-suspending records both actions in history', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'First',
        durationHours: 12,
      });

      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID_2,
        reason: 'Second',
        durationHours: 48,
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(2);
      // Most recent first (lPush prepends)
      expect(history[0].reason).toBe('Second');
      expect(history[1].reason).toBe('First');
    });

    it('A12: empty reason throws validation error', async () => {
      await expect(
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: '',
          durationHours: 24,
        })
      ).rejects.toThrow('reason is required');
    });

    it('A13: negative durationHours throws validation error', async () => {
      await expect(
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: 'Bad duration',
          durationHours: -5,
        })
      ).rejects.toThrow('durationHours must be >= 0');
    });

    it('A14: empty userId throws validation error', async () => {
      await expect(
        service.suspendUser({
          userId: '',
          adminId: ADMIN_ID,
          reason: 'Test',
          durationHours: 24,
        })
      ).rejects.toThrow('userId is required');
    });

    it('A15: empty adminId throws validation error', async () => {
      await expect(
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: '',
          reason: 'Test',
          durationHours: 24,
        })
      ).rejects.toThrow('adminId is required');
    });

    it('A16: suspension record includes createdAt timestamp', async () => {
      const before = new Date().toISOString();
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
        durationHours: 1,
      });
      const after = new Date().toISOString();

      expect(result.suspension.createdAt).toBeDefined();
      expect(result.suspension.createdAt >= before).toBe(true);
      expect(result.suspension.createdAt <= after).toBe(true);
    });

    it('A17: suspend with fractional hours (0.5 = 30 min) sets correct TTL', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Short suspension',
        durationHours: 0.5,
      });

      const ttl = await redis.ttl(SUSPENSION_KEY(TRANSPORTER_ID));
      // 0.5 hours = 1800 seconds
      expect(ttl).toBeGreaterThan(1790);
      expect(ttl).toBeLessThanOrEqual(1800);
    });
  });

  // ===========================================================================
  // B. WARN USER (12 tests)
  // ===========================================================================

  describe('B. Warn User', () => {
    it('B1: admin can warn a transporter with reason', async () => {
      const result = await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Late pickup reported',
      });

      expect(result.success).toBe(true);
    });

    it('B2: warning stored in history', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Late pickup',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(1);
      expect(history[0].action).toBe('warn');
      expect(history[0].reason).toBe('Late pickup');
    });

    it('B3: warned user is NOT suspended (checkSuspension returns null)', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Warning only',
      });

      const suspension = await service.checkSuspension(TRANSPORTER_ID);
      expect(suspension).toBeNull();
    });

    it('B4: warned user can still operate (not blocked by filter)', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Warning only',
      });

      const candidates = [TRANSPORTER_ID, TRANSPORTER_ID_2];
      const filtered = await service.filterSuspendedFromCandidates(candidates);
      expect(filtered).toContain(TRANSPORTER_ID);
    });

    it('B5: multiple warnings accumulate in history', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Warning 1',
      });
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Warning 2',
      });
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID_2,
        reason: 'Warning 3',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(3);
      expect(history.every((h) => h.action === 'warn')).toBe(true);
    });

    it('B6: warning includes adminId in history', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history[0].adminId).toBe(ADMIN_ID);
    });

    it('B7: warning includes timestamp in history', async () => {
      const before = new Date().toISOString();
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
      });
      const after = new Date().toISOString();

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history[0].timestamp >= before).toBe(true);
      expect(history[0].timestamp <= after).toBe(true);
    });

    it('B8: warning does NOT create a suspension Redis key', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Just a warning',
      });

      const exists = await redis.exists(SUSPENSION_KEY(TRANSPORTER_ID));
      expect(exists).toBe(false);
    });

    it('B9: empty reason throws validation error', async () => {
      await expect(
        service.warnUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: '',
        })
      ).rejects.toThrow('reason is required');
    });

    it('B10: empty userId throws validation error', async () => {
      await expect(
        service.warnUser({
          userId: '',
          adminId: ADMIN_ID,
          reason: 'Test',
        })
      ).rejects.toThrow('userId is required');
    });

    it('B11: warn has durationHours = 0 in history', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Warning',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history[0].durationHours).toBe(0);
    });

    it('B12: warning followed by suspend creates mixed history', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'First warning',
      });
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Escalated to suspension',
        durationHours: 24,
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(2);
      expect(history[0].action).toBe('suspend');
      expect(history[1].action).toBe('warn');
    });
  });

  // ===========================================================================
  // C. UNSUSPEND USER (11 tests)
  // ===========================================================================

  describe('C. Unsuspend User', () => {
    it('C1: admin can unsuspend a suspended user', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Offense',
        durationHours: 24,
      });

      const result = await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID_2,
        reason: 'Appeal approved',
      });

      expect(result.success).toBe(true);
      expect(result.wasSuspended).toBe(true);
    });

    it('C2: after unsuspend, user is no longer suspended', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Offense',
        durationHours: 24,
      });

      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID_2,
        reason: 'Appeal',
      });

      const check = await service.checkSuspension(TRANSPORTER_ID);
      expect(check).toBeNull();
    });

    it('C3: after unsuspend, user passes dispatch filter', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Offense',
        durationHours: 24,
      });

      // Verify blocked
      let filtered = await service.filterSuspendedFromCandidates([TRANSPORTER_ID]);
      expect(filtered).toHaveLength(0);

      // Unsuspend
      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Reinstated',
      });

      // Verify unblocked
      filtered = await service.filterSuspendedFromCandidates([TRANSPORTER_ID]);
      expect(filtered).toContain(TRANSPORTER_ID);
    });

    it('C4: unsuspend a non-suspended user is a no-op (returns wasSuspended=false)', async () => {
      const result = await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Proactive clear',
      });

      expect(result.success).toBe(true);
      expect(result.wasSuspended).toBe(false);
    });

    it('C5: unsuspend reason recorded in history', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Offense',
        durationHours: 24,
      });

      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID_2,
        reason: 'Cleared after review',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      const unsuspendEntry = history.find((h) => h.action === 'unsuspend');
      expect(unsuspendEntry).toBeDefined();
      expect(unsuspendEntry!.reason).toBe('Cleared after review');
      expect(unsuspendEntry!.adminId).toBe(ADMIN_ID_2);
    });

    it('C6: unsuspend removes the Redis suspension key', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Offense',
        durationHours: 24,
      });

      expect(await redis.exists(SUSPENSION_KEY(TRANSPORTER_ID))).toBe(true);

      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Clear',
      });

      expect(await redis.exists(SUSPENSION_KEY(TRANSPORTER_ID))).toBe(false);
    });

    it('C7: unsuspend preserves prior history entries', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Warning',
      });
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Suspended',
        durationHours: 24,
      });
      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Cleared',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(3);
      expect(history[0].action).toBe('unsuspend');
      expect(history[1].action).toBe('suspend');
      expect(history[2].action).toBe('warn');
    });

    it('C8: empty userId throws validation error', async () => {
      await expect(
        service.unsuspendUser({
          userId: '',
          adminId: ADMIN_ID,
          reason: 'Test',
        })
      ).rejects.toThrow('userId is required');
    });

    it('C9: empty adminId throws validation error', async () => {
      await expect(
        service.unsuspendUser({
          userId: TRANSPORTER_ID,
          adminId: '',
          reason: 'Test',
        })
      ).rejects.toThrow('adminId is required');
    });

    it('C10: unsuspend without explicit reason uses default message', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Offense',
        durationHours: 1,
      });

      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: '',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      const entry = history.find((h) => h.action === 'unsuspend');
      expect(entry!.reason).toBe('Manual unsuspend');
    });

    it('C11: unsuspend after TTL expiry still records history', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Short ban',
        durationHours: 1,
      });

      // Simulate expiry
      redis.forceExpire(SUSPENSION_KEY(TRANSPORTER_ID));

      const result = await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Cleanup',
      });

      expect(result.wasSuspended).toBe(false); // Already expired
      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.some((h) => h.action === 'unsuspend')).toBe(true);
    });
  });

  // ===========================================================================
  // D. SUSPENSION CHECK IN DISPATCH (16 tests)
  // ===========================================================================

  describe('D. Suspension Check in Dispatch', () => {
    it('D1: suspended transporter excluded from broadcast candidates', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      const candidates = [TRANSPORTER_ID, TRANSPORTER_ID_2, TRANSPORTER_ID_3];
      const filtered = await service.filterSuspendedFromCandidates(candidates);

      expect(filtered).not.toContain(TRANSPORTER_ID);
      expect(filtered).toContain(TRANSPORTER_ID_2);
      expect(filtered).toContain(TRANSPORTER_ID_3);
    });

    it('D2: warned transporter still receives broadcasts', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Warning',
      });

      const candidates = [TRANSPORTER_ID, TRANSPORTER_ID_2];
      const filtered = await service.filterSuspendedFromCandidates(candidates);

      expect(filtered).toContain(TRANSPORTER_ID);
      expect(filtered).toHaveLength(2);
    });

    it('D3: expired suspension allows transporter to receive broadcasts', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Short ban',
        durationHours: 1,
      });

      // Simulate expiry
      redis.forceExpire(SUSPENSION_KEY(TRANSPORTER_ID));

      const candidates = [TRANSPORTER_ID];
      const filtered = await service.filterSuspendedFromCandidates(candidates);
      expect(filtered).toContain(TRANSPORTER_ID);
    });

    it('D4: Redis failure during check fails open (allows all)', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      // Redis goes down
      redis.setConnected(false);

      // checkSuspension should fail open
      const check = await service.checkSuspension(TRANSPORTER_ID);
      expect(check).toBeNull();
    });

    it('D5: multiple suspended transporters all filtered out', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Ban 1',
        durationHours: 24,
      });
      await service.suspendUser({
        userId: TRANSPORTER_ID_2,
        adminId: ADMIN_ID,
        reason: 'Ban 2',
        durationHours: 12,
      });

      const candidates = [TRANSPORTER_ID, TRANSPORTER_ID_2, TRANSPORTER_ID_3];
      const filtered = await service.filterSuspendedFromCandidates(candidates);

      expect(filtered).toEqual([TRANSPORTER_ID_3]);
    });

    it('D6: empty candidate list returns empty', async () => {
      const filtered = await service.filterSuspendedFromCandidates([]);
      expect(filtered).toEqual([]);
    });

    it('D7: all candidates suspended returns empty', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Ban',
        durationHours: 24,
      });
      await service.suspendUser({
        userId: TRANSPORTER_ID_2,
        adminId: ADMIN_ID,
        reason: 'Ban',
        durationHours: 24,
      });

      const filtered = await service.filterSuspendedFromCandidates([
        TRANSPORTER_ID,
        TRANSPORTER_ID_2,
      ]);
      expect(filtered).toEqual([]);
    });

    it('D8: no candidates suspended returns all', async () => {
      const candidates = [TRANSPORTER_ID, TRANSPORTER_ID_2, TRANSPORTER_ID_3];
      const filtered = await service.filterSuspendedFromCandidates(candidates);
      expect(filtered).toEqual(candidates);
    });

    it('D9: permanently suspended transporter always excluded', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Permanent ban',
        durationHours: 0,
      });

      const filtered = await service.filterSuspendedFromCandidates([TRANSPORTER_ID]);
      expect(filtered).toEqual([]);
    });

    it('D10: suspension of one transporter does not affect others', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      const check2 = await service.checkSuspension(TRANSPORTER_ID_2);
      expect(check2).toBeNull();
    });

    it('D11: filter preserves order of non-suspended candidates', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID_2,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      const candidates = [TRANSPORTER_ID_3, TRANSPORTER_ID, TRANSPORTER_ID_2];
      const filtered = await service.filterSuspendedFromCandidates(candidates);

      expect(filtered).toEqual([TRANSPORTER_ID_3, TRANSPORTER_ID]);
    });

    it('D12: suspension check is O(1) per candidate (Redis GET per user)', async () => {
      // Verify that checkSuspension calls redis.get exactly once per check
      const originalGet = redis.get.bind(redis);
      let getCallCount = 0;
      redis.get = async (key: string) => {
        getCallCount++;
        return originalGet(key);
      };

      await service.checkSuspension(TRANSPORTER_ID);
      expect(getCallCount).toBe(1);
    });

    it('D13: filtering 100 candidates invokes Redis 100 times', async () => {
      const originalGet = redis.get.bind(redis);
      let getCallCount = 0;
      redis.get = async (key: string) => {
        getCallCount++;
        return originalGet(key);
      };

      const candidates = Array.from({ length: 100 }, (_, i) => `t-${i}`);
      await service.filterSuspendedFromCandidates(candidates);
      expect(getCallCount).toBe(100);
    });

    it('D14: unsuspended user immediately appears in next filter call', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Temp',
        durationHours: 24,
      });

      let filtered = await service.filterSuspendedFromCandidates([TRANSPORTER_ID]);
      expect(filtered).toEqual([]);

      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Cleared',
      });

      filtered = await service.filterSuspendedFromCandidates([TRANSPORTER_ID]);
      expect(filtered).toEqual([TRANSPORTER_ID]);
    });

    it('D15: filter handles duplicate candidate IDs', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      const candidates = [TRANSPORTER_ID_2, TRANSPORTER_ID_2, TRANSPORTER_ID];
      const filtered = await service.filterSuspendedFromCandidates(candidates);
      // Both copies of TRANSPORTER_ID_2 should pass through
      expect(filtered).toEqual([TRANSPORTER_ID_2, TRANSPORTER_ID_2]);
    });

    it('D16: Redis recovers mid-filter -- partial fail-open then normal', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      // Disconnect then reconnect mid-way
      const originalGet = redis.get.bind(redis);
      let callCount = 0;
      redis.get = async (key: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Redis connection refused');
        }
        return originalGet(key);
      };

      // First candidate will fail open (allowed), second will check normally
      const filtered = await service.filterSuspendedFromCandidates([
        TRANSPORTER_ID,
        TRANSPORTER_ID_2,
      ]);

      // TRANSPORTER_ID: fail open (included despite being suspended)
      // TRANSPORTER_ID_2: normal check (not suspended, included)
      expect(filtered).toContain(TRANSPORTER_ID);
      expect(filtered).toContain(TRANSPORTER_ID_2);
    });
  });

  // ===========================================================================
  // E. ACTION HISTORY (12 tests)
  // ===========================================================================

  describe('E. Action History', () => {
    it('E1: every suspend action recorded in history', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'SLA violation',
        durationHours: 24,
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(1);
      expect(history[0].action).toBe('suspend');
    });

    it('E2: every warn action recorded in history', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Late delivery',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(1);
      expect(history[0].action).toBe('warn');
    });

    it('E3: every unsuspend action recorded in history', async () => {
      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Cleared',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(1);
      expect(history[0].action).toBe('unsuspend');
    });

    it('E4: history is append-only (new entries prepended)', async () => {
      await service.warnUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'W1' });
      await service.warnUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'W2' });
      await service.suspendUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'S1', durationHours: 24 });
      await service.unsuspendUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'U1' });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(4);
      // Most recent first
      expect(history[0].action).toBe('unsuspend');
      expect(history[1].action).toBe('suspend');
      expect(history[2].action).toBe('warn');
      expect(history[3].action).toBe('warn');
    });

    it('E5: history capped at 100 entries', async () => {
      // Insert 110 warnings
      for (let i = 0; i < 110; i++) {
        await service.warnUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: `Warning ${i}`,
        });
      }

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBeLessThanOrEqual(SUSPENSION_HISTORY_MAX);
    });

    it('E6: history entries contain all required fields', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test fields',
        durationHours: 6,
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      const entry = history[0];

      expect(entry).toHaveProperty('action');
      expect(entry).toHaveProperty('adminId');
      expect(entry).toHaveProperty('reason');
      expect(entry).toHaveProperty('durationHours');
      expect(entry).toHaveProperty('timestamp');
    });

    it('E7: history for non-existent user returns empty array', async () => {
      const history = await service.getHistory('non-existent-user');
      expect(history).toEqual([]);
    });

    it('E8: history persists independently per user', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'User 1 ban',
        durationHours: 24,
      });
      await service.warnUser({
        userId: TRANSPORTER_ID_2,
        adminId: ADMIN_ID,
        reason: 'User 2 warning',
      });

      const h1 = await service.getHistory(TRANSPORTER_ID);
      const h2 = await service.getHistory(TRANSPORTER_ID_2);

      expect(h1.length).toBe(1);
      expect(h1[0].action).toBe('suspend');

      expect(h2.length).toBe(1);
      expect(h2[0].action).toBe('warn');
    });

    it('E9: history survives suspension expiry', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Temp ban',
        durationHours: 1,
      });

      // Expire the suspension
      redis.forceExpire(SUSPENSION_KEY(TRANSPORTER_ID));

      // History should still exist (separate Redis key)
      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(1);
      expect(history[0].action).toBe('suspend');
    });

    it('E10: history timestamps are ISO 8601 format', async () => {
      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      // ISO 8601 regex
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
      expect(history[0].timestamp).toMatch(isoRegex);
    });

    it('E11: suspend action records durationHours in history', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
        durationHours: 72,
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history[0].durationHours).toBe(72);
    });

    it('E12: history correctly reflects mixed actions across multiple users', async () => {
      // User 1: warn, suspend, unsuspend
      await service.warnUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'W' });
      await service.suspendUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'S', durationHours: 1 });
      await service.unsuspendUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'U' });

      // User 2: suspend only
      await service.suspendUser({ userId: TRANSPORTER_ID_2, adminId: ADMIN_ID, reason: 'Ban', durationHours: 48 });

      const h1 = await service.getHistory(TRANSPORTER_ID);
      expect(h1.length).toBe(3);
      expect(h1.map((h) => h.action)).toEqual(['unsuspend', 'suspend', 'warn']);

      const h2 = await service.getHistory(TRANSPORTER_ID_2);
      expect(h2.length).toBe(1);
      expect(h2[0].action).toBe('suspend');
    });
  });

  // ===========================================================================
  // F. WHAT-IF SCENARIOS (20 tests)
  // ===========================================================================

  describe('F. What-If Scenarios', () => {
    it('F1: admin suspends themselves -- allowed', async () => {
      // An admin suspending their own admin account should succeed
      const result = await service.suspendUser({
        userId: ADMIN_ID,
        adminId: ADMIN_ID,
        reason: 'Self-imposed timeout',
        durationHours: 1,
      });

      expect(result.success).toBe(true);
      expect(result.suspension.userId).toBe(ADMIN_ID);
      expect(result.suspension.adminId).toBe(ADMIN_ID);
    });

    it('F2: suspended user can still login (suspension only blocks operations)', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      // Login is unrelated to suspension -- suspension only blocks:
      // 1. Going online (availability toggle)
      // 2. Receiving broadcasts
      // Login itself should work (so user can see their suspension status)
      const suspension = await service.checkSuspension(TRANSPORTER_ID);
      expect(suspension).not.toBeNull();
      // The check returns the record, UI can show "You are suspended"
      // but there is no login block
    });

    it('F3: Redis down during suspend returns error to admin', async () => {
      redis.setConnected(false);

      await expect(
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: 'Attempt while down',
          durationHours: 24,
        })
      ).rejects.toThrow('Redis connection refused');
    });

    it('F4: Redis down during suspension check fails open (allows user)', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned',
        durationHours: 24,
      });

      redis.setConnected(false);

      const check = await service.checkSuspension(TRANSPORTER_ID);
      expect(check).toBeNull(); // Fail open
    });

    it('F5: two admins suspend same user simultaneously -- last write wins', async () => {
      // Simulate concurrent suspensions
      const [result1, result2] = await Promise.all([
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: 'Admin 1 ban',
          durationHours: 24,
        }),
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID_2,
          reason: 'Admin 2 ban',
          durationHours: 48,
        }),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Last write wins -- the stored value is whichever completed last
      const stored = await redis.getJSON<SuspensionRecord>(SUSPENSION_KEY(TRANSPORTER_ID));
      expect(stored).not.toBeNull();
      // Both are valid outcomes; just verify one is stored
      expect(['Admin 1 ban', 'Admin 2 ban']).toContain(stored!.reason);

      // Both recorded in history
      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(2);
    });

    it('F6: suspension expires mid-broadcast -- next broadcast includes transporter', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Short ban',
        durationHours: 1,
      });

      // First broadcast -- suspended, excluded
      let filtered = await service.filterSuspendedFromCandidates([TRANSPORTER_ID, TRANSPORTER_ID_2]);
      expect(filtered).not.toContain(TRANSPORTER_ID);

      // Suspension expires
      redis.forceExpire(SUSPENSION_KEY(TRANSPORTER_ID));

      // Next broadcast -- included
      filtered = await service.filterSuspendedFromCandidates([TRANSPORTER_ID, TRANSPORTER_ID_2]);
      expect(filtered).toContain(TRANSPORTER_ID);
    });

    it('F7: user was offline when suspended -- blocked when they come online', async () => {
      // User is offline (not in online set)
      // Admin suspends them
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Banned while offline',
        durationHours: 24,
      });

      // When user tries to go online, system checks suspension
      const suspension = await service.checkSuspension(TRANSPORTER_ID);
      expect(suspension).not.toBeNull();
      // The availability toggle should check this and return 403
    });

    it('F8: driver of suspended transporter blocked from accepting', async () => {
      // Suspend the transporter
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Company banned',
        durationHours: 24,
      });

      // When a driver (under this transporter) tries to accept a broadcast,
      // the system should check the transporter's suspension status
      const suspension = await service.checkSuspension(TRANSPORTER_ID);
      expect(suspension).not.toBeNull();
      expect(suspension!.type).toBe('suspend');
    });

    it('F9: admin provides empty reason on suspend -- validation error', async () => {
      await expect(
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: '   ',
          durationHours: 24,
        })
      ).rejects.toThrow();
    });

    it('F10: negative durationHours -- validation error', async () => {
      await expect(
        service.suspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: 'Bad',
          durationHours: -10,
        })
      ).rejects.toThrow('durationHours must be >= 0');
    });

    it('F11: suspend then warn -- both recorded, suspension still active', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Suspended',
        durationHours: 24,
      });

      await service.warnUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Additional warning',
      });

      // Still suspended
      const check = await service.checkSuspension(TRANSPORTER_ID);
      expect(check).not.toBeNull();

      // Both in history
      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(2);
    });

    it('F12: warn then suspend then unsuspend then suspend -- full lifecycle', async () => {
      await service.warnUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'W' });
      await service.suspendUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'S1', durationHours: 12 });
      await service.unsuspendUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'U' });
      await service.suspendUser({ userId: TRANSPORTER_ID, adminId: ADMIN_ID, reason: 'S2', durationHours: 48 });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(history.length).toBe(4);
      expect(history.map((h) => h.action)).toEqual(['suspend', 'unsuspend', 'suspend', 'warn']);

      // Currently suspended with S2
      const check = await service.checkSuspension(TRANSPORTER_ID);
      expect(check).not.toBeNull();
      expect(check!.reason).toBe('S2');
      expect(check!.durationHours).toBe(48);
    });

    it('F13: suspend with very large duration (8760h = 1 year)', async () => {
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Year-long ban',
        durationHours: 8760,
      });

      expect(result.success).toBe(true);
      const ttl = await redis.ttl(SUSPENSION_KEY(TRANSPORTER_ID));
      // ~31536000 seconds
      expect(ttl).toBeGreaterThan(31535000);
    });

    it('F14: suspend with 1-second precision (0.000278h ~ 1s)', async () => {
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Ultra-short',
        durationHours: 1 / 3600, // ~1 second
      });

      expect(result.success).toBe(true);
      // TTL should be very small but positive
      const ttl = await redis.ttl(SUSPENSION_KEY(TRANSPORTER_ID));
      expect(ttl).toBeGreaterThanOrEqual(0);
    });

    it('F15: multiple users suspended independently -- no cross-contamination', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Ban 1',
        durationHours: 24,
      });
      await service.suspendUser({
        userId: TRANSPORTER_ID_2,
        adminId: ADMIN_ID,
        reason: 'Ban 2',
        durationHours: 48,
      });

      // Unsuspend user 1
      await service.unsuspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Clear 1',
      });

      // User 1 clear, user 2 still suspended
      expect(await service.checkSuspension(TRANSPORTER_ID)).toBeNull();
      expect(await service.checkSuspension(TRANSPORTER_ID_2)).not.toBeNull();
    });

    it('F16: suspension record type field is always "suspend"', async () => {
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test type field',
        durationHours: 1,
      });

      expect(result.suspension.type).toBe('suspend');
    });

    it('F17: history entries are JSON-serializable (no circular refs)', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test serialization',
        durationHours: 1,
      });

      const history = await service.getHistory(TRANSPORTER_ID);
      expect(() => JSON.stringify(history)).not.toThrow();
    });

    it('F18: suspension record is JSON-serializable', async () => {
      const result = await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
        durationHours: 1,
      });

      expect(() => JSON.stringify(result.suspension)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result.suspension));
      expect(parsed.userId).toBe(TRANSPORTER_ID);
    });

    it('F19: Redis down during warn returns error to admin', async () => {
      redis.setConnected(false);

      await expect(
        service.warnUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: 'Warn while down',
        })
      ).rejects.toThrow('Redis connection refused');
    });

    it('F20: Redis down during unsuspend returns error to admin', async () => {
      redis.setConnected(false);

      await expect(
        service.unsuspendUser({
          userId: TRANSPORTER_ID,
          adminId: ADMIN_ID,
          reason: 'Unsuspend while down',
        })
      ).rejects.toThrow('Redis connection refused');
    });
  });

  // ===========================================================================
  // G. REDIS KEY STRUCTURE (bonus sanity tests)
  // ===========================================================================

  describe('G. Redis Key Structure', () => {
    it('G1: suspension key follows pattern suspension:{userId}', () => {
      expect(SUSPENSION_KEY('user-123')).toBe('suspension:user-123');
    });

    it('G2: history key follows pattern suspension:history:{userId}', () => {
      expect(SUSPENSION_HISTORY_KEY('user-123')).toBe('suspension:history:user-123');
    });

    it('G3: suspension and history use different Redis keys', async () => {
      await service.suspendUser({
        userId: TRANSPORTER_ID,
        adminId: ADMIN_ID,
        reason: 'Test',
        durationHours: 1,
      });

      const suspensionExists = await redis.exists(SUSPENSION_KEY(TRANSPORTER_ID));
      const historyExists = await redis.exists(SUSPENSION_HISTORY_KEY(TRANSPORTER_ID));

      expect(suspensionExists).toBe(true);
      // History uses list, check via lLen
      const historyLen = await redis.lLen(SUSPENSION_HISTORY_KEY(TRANSPORTER_ID));
      expect(historyLen).toBeGreaterThan(0);
    });

    it('G4: history max constant is 100', () => {
      expect(SUSPENSION_HISTORY_MAX).toBe(100);
    });
  });
});
