/**
 * =============================================================================
 * F-C-54 — fcm_token_refresh field-name compatibility
 * =============================================================================
 *
 * Backend's `fcm_token_refresh` socket handler previously destructured
 * `data.token`, but the captain app emits `{fcmToken: "..."}`. The guard
 * silently returned, so the DB never persisted the refreshed FCM token.
 *
 * Fix (F-C-54, per WEELO-CRITICAL-SOLUTION.md):
 *   - Accept BOTH `fcmToken` (canonical) and `token` (legacy alias).
 *   - Prefer `fcmToken`.
 *   - If neither present, increment `fcm_token_refresh_bad_payload_total`.
 *   - Emit `fcm_token_refresh_ack {success:true}` on successful persist.
 *
 * These tests verify both:
 *   (1) The source file `socket.service.ts` contains the patched handler
 *       shape (dual-key destructure, nullish-coalescing pick, bad-payload
 *       metric, ACK emit) — structural check to prevent silent regression.
 *   (2) Behavioral replay of the handler logic against mocks — covers the
 *       5 scenarios (fcmToken, token, both, neither, short-token).
 *
 * @fixes F-C-54
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// Test fixture: replay of the patched handler body against mocks.
// This must stay in lockstep with socket.service.ts lines 1312-1333.
// If you change the handler, update this function AND the structural test below.
// =============================================================================

interface HandlerDeps {
  registerToken: (userId: string, tok: string) => Promise<void>;
  incrementCounter: (name: string) => void;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  emit: (event: string, payload: unknown) => void;
  userId: string | null;
}

async function runFcmTokenRefreshHandler(
  data: { fcmToken?: string; token?: string } | undefined | null,
  deps: HandlerDeps,
): Promise<void> {
  try {
    const receivedToken = data?.fcmToken ?? data?.token;
    if (!receivedToken || receivedToken.length < 10) {
      try {
        deps.incrementCounter('fcm_token_refresh_bad_payload_total');
      } catch { /* metrics unavailable — non-critical */ }
      return;
    }
    if (!deps.userId) return;
    await deps.registerToken(deps.userId, receivedToken);
    deps.logger.info('[FCM] Mid-session token refresh via socket', { userId: deps.userId });
    deps.emit('fcm_token_refresh_ack', { success: true });
  } catch (error) {
    deps.logger.error('[FCM] Token refresh failed', { userId: deps.userId, error });
    deps.emit('fcm_token_refresh_ack', { success: false });
  }
}

// =============================================================================
// Mock factory
// =============================================================================

function makeDeps(overrides: Partial<HandlerDeps> = {}): {
  deps: HandlerDeps;
  registerToken: jest.Mock;
  incrementCounter: jest.Mock;
  emit: jest.Mock;
  logInfo: jest.Mock;
  logError: jest.Mock;
} {
  const registerToken = jest.fn<Promise<void>, [string, string]>().mockResolvedValue();
  const incrementCounter = jest.fn<void, [string]>();
  const emit = jest.fn<void, [string, unknown]>();
  const logInfo = jest.fn();
  const logError = jest.fn();

  const deps: HandlerDeps = {
    registerToken,
    incrementCounter,
    logger: { info: logInfo, error: logError },
    emit,
    userId: 'user-fcm-test-001',
    ...overrides,
  };

  return { deps, registerToken, incrementCounter, emit, logInfo, logError };
}

// =============================================================================
// STRUCTURAL TEST — proves the patched code is in socket.service.ts
// =============================================================================

describe('F-C-54 — structural check on socket.service.ts', () => {
  let socketSource: string;

  beforeAll(() => {
    socketSource = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8',
    );
  });

  it('declares handler with dual-key destructure (fcmToken + token)', () => {
    // Must accept both field names so older `{token}` and newer `{fcmToken}`
    // captain builds both work during transition.
    expect(socketSource).toMatch(
      /socket\.on\('fcm_token_refresh',\s*async\s*\(data:\s*\{\s*fcmToken\?:\s*string;\s*token\?:\s*string\s*\}\)/,
    );
  });

  it('uses nullish coalescing to pick receivedToken (fcmToken wins)', () => {
    expect(socketSource).toContain('data?.fcmToken ?? data?.token');
  });

  it('increments fcm_token_refresh_bad_payload_total on bad payload', () => {
    expect(socketSource).toContain('fcm_token_refresh_bad_payload_total');
  });

  it('passes receivedToken (not data.token) to fcmService.registerToken', () => {
    expect(socketSource).toContain('fcmService.registerToken(userId, receivedToken)');
  });

  it('emits success ACK after persist', () => {
    expect(socketSource).toMatch(
      /socket\.emit\('fcm_token_refresh_ack',\s*\{\s*success:\s*true\s*\}\)/,
    );
  });
});

// =============================================================================
// BEHAVIORAL TESTS — replay handler logic against mocks (5 scenarios)
// =============================================================================

describe('F-C-54 — fcm_token_refresh handler behavior', () => {
  // ---------------------------------------------------------------------------
  // (a) {fcmToken} payload → persists + ACK success
  // ---------------------------------------------------------------------------
  it('persists token and emits ACK success when payload uses {fcmToken}', async () => {
    const { deps, registerToken, incrementCounter, emit } = makeDeps();

    await runFcmTokenRefreshHandler({ fcmToken: 'abc123def456ghi789' }, deps);

    expect(registerToken).toHaveBeenCalledTimes(1);
    expect(registerToken).toHaveBeenCalledWith('user-fcm-test-001', 'abc123def456ghi789');
    expect(emit).toHaveBeenCalledWith('fcm_token_refresh_ack', { success: true });
    expect(incrementCounter).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (b) {token} payload → persists + ACK success (backward compat)
  // ---------------------------------------------------------------------------
  it('persists token and emits ACK success when payload uses legacy {token}', async () => {
    const { deps, registerToken, incrementCounter, emit } = makeDeps();

    await runFcmTokenRefreshHandler({ token: 'legacy-tok-9876543210' }, deps);

    expect(registerToken).toHaveBeenCalledTimes(1);
    expect(registerToken).toHaveBeenCalledWith('user-fcm-test-001', 'legacy-tok-9876543210');
    expect(emit).toHaveBeenCalledWith('fcm_token_refresh_ack', { success: true });
    expect(incrementCounter).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (c) Both keys present → fcmToken wins
  // ---------------------------------------------------------------------------
  it('prefers fcmToken over legacy token when both are present', async () => {
    const { deps, registerToken, emit } = makeDeps();

    await runFcmTokenRefreshHandler(
      { fcmToken: 'NEW-TOKEN-VALUE-1234', token: 'OLD-TOKEN-VALUE-1234' },
      deps,
    );

    expect(registerToken).toHaveBeenCalledTimes(1);
    expect(registerToken).toHaveBeenCalledWith(
      'user-fcm-test-001',
      'NEW-TOKEN-VALUE-1234',
    );
    expect(emit).toHaveBeenCalledWith('fcm_token_refresh_ack', { success: true });
  });

  // ---------------------------------------------------------------------------
  // (d) Neither key present → metric increments, no ACK, no exception
  // ---------------------------------------------------------------------------
  it('increments bad-payload counter and returns silently when neither field is present', async () => {
    const { deps, registerToken, incrementCounter, emit } = makeDeps();

    await expect(runFcmTokenRefreshHandler({}, deps)).resolves.toBeUndefined();

    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(incrementCounter).toHaveBeenCalledWith('fcm_token_refresh_bad_payload_total');
    expect(registerToken).not.toHaveBeenCalled();
    // Silent return — no ACK leak of field-missing vs field-invalid.
    expect(emit).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (e) Short token (<10 chars) → treated as bad payload
  // ---------------------------------------------------------------------------
  it('treats a token shorter than 10 chars as a bad payload (metric, silent return)', async () => {
    const { deps, registerToken, incrementCounter, emit } = makeDeps();

    await runFcmTokenRefreshHandler({ fcmToken: 'short' }, deps);

    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(incrementCounter).toHaveBeenCalledWith('fcm_token_refresh_bad_payload_total');
    expect(registerToken).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Defence-in-depth: null/undefined payload must not crash
  // ---------------------------------------------------------------------------
  it('handles undefined payload without throwing', async () => {
    const { deps, registerToken, incrementCounter, emit } = makeDeps();

    await expect(runFcmTokenRefreshHandler(undefined, deps)).resolves.toBeUndefined();

    expect(incrementCounter).toHaveBeenCalledWith('fcm_token_refresh_bad_payload_total');
    expect(registerToken).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits ACK success:false if registerToken rejects', async () => {
    const registerToken = jest.fn<Promise<void>, [string, string]>()
      .mockRejectedValue(new Error('Redis down'));
    const { deps, emit, logError } = makeDeps({ registerToken });

    await runFcmTokenRefreshHandler({ fcmToken: 'valid-token-1234567' }, deps);

    expect(registerToken).toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      '[FCM] Token refresh failed',
      expect.objectContaining({ userId: 'user-fcm-test-001' }),
    );
    expect(emit).toHaveBeenCalledWith('fcm_token_refresh_ack', { success: false });
  });
});
