/**
 * =============================================================================
 * QA PHASE 4 -- DLQ + OUTBOX EDGE CASE TESTS
 * =============================================================================
 *
 * Covers: H3 -- DLQ metric + logger.error + admin re-drive
 *
 * Groups:
 *   1. DLQ Metric Emission -- dispatch_dlq_total in BOTH paths
 *   2. DLQ Logger.error -- structured logging with orderId, attempts, lastError
 *   3. Admin Re-drive Endpoint -- route existence, auth guards, 404, reset logic
 *   4. redriveFailedDispatch -- behavioral edge cases
 *   5. processDispatchOutboxRow -- retry-exhaustion DLQ path
 *   6. processDispatchOutboxRow -- exception-exhaustion DLQ path
 *   7. Concurrent re-drive safety
 *
 * Source files under test:
 *   - src/modules/order/order-dispatch-outbox.service.ts
 *   - src/modules/admin/admin.routes.ts
 *   - src/modules/admin/admin.controller.ts
 *
 * @author QA-Agent4 -- DLQ Edge Cases
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Source file paths (absolute for reliable reads)
// ---------------------------------------------------------------------------
const OUTBOX_SERVICE_PATH = path.resolve(
  __dirname,
  '../modules/order/order-dispatch-outbox.service.ts'
);
const ADMIN_ROUTES_PATH = path.resolve(
  __dirname,
  '../modules/admin/admin.routes.ts'
);
const ADMIN_CONTROLLER_PATH = path.resolve(
  __dirname,
  '../modules/admin/admin.controller.ts'
);

// ---------------------------------------------------------------------------
// Helper: read a source file as UTF-8
// ---------------------------------------------------------------------------
function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

// =============================================================================
// GROUP 1: DLQ METRIC EMISSION -- dispatch_dlq_total in BOTH paths
// =============================================================================
describe('GROUP 1: DLQ metric emission -- dispatch_dlq_total', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('dispatch_dlq_total metric is emitted in the retry-exhausted path', () => {
    // After max retries with DISPATCH_RETRYING reason, must emit DLQ metric
    const retryExhaustedPattern =
      /metrics\.incrementCounter\(\s*['"]dispatch_dlq_total['"]\s*,\s*\{[^}]*reason:\s*['"]RETRY_EXHAUSTED['"]/;
    expect(src).toMatch(retryExhaustedPattern);
  });

  test('dispatch_dlq_total metric is emitted in the exception-exhausted path', () => {
    // When a thrown exception exhausts all retries, must emit DLQ metric
    const exceptionExhaustedPattern =
      /metrics\.incrementCounter\(\s*['"]dispatch_dlq_total['"]\s*,\s*\{[^}]*reason:\s*['"]EXCEPTION_EXHAUSTED['"]/;
    expect(src).toMatch(exceptionExhaustedPattern);
  });

  test('dispatch_dlq_total includes orderId label in retry-exhausted path', () => {
    // The metric call must include an orderId label for dashboard filtering
    const pattern =
      /metrics\.incrementCounter\(\s*['"]dispatch_dlq_total['"]\s*,\s*\{[^}]*orderId:/;
    const matches = src.match(new RegExp(pattern, 'g'));
    // Must appear at least twice (retry-exhausted + exception-exhausted)
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  test('dispatch_dlq_redrive_total metric is emitted in redriveFailedDispatch', () => {
    // When admin re-drives a failed row, must emit redrive metric
    const redrivePattern =
      /metrics\.incrementCounter\(\s*['"]dispatch_dlq_redrive_total['"]/;
    expect(src).toMatch(redrivePattern);
  });

  test('dispatch_dlq_redrive_total includes orderId label', () => {
    const pattern =
      /metrics\.incrementCounter\(\s*['"]dispatch_dlq_redrive_total['"]\s*,\s*\{[^}]*orderId/;
    expect(src).toMatch(pattern);
  });
});

// =============================================================================
// GROUP 2: DLQ LOGGER.ERROR -- structured log fields
// =============================================================================
describe('GROUP 2: DLQ logger.error -- structured fields', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('logger.error is called with DLQ tag for retry-exhausted path', () => {
    // Must log with recognizable tag for operator alerting
    expect(src).toContain(
      "logger.error('[DispatchOutbox] Message moved to DLQ after max retries'"
    );
  });

  test('logger.error is called with DLQ tag for exception-exhausted path', () => {
    expect(src).toContain(
      "logger.error('[DispatchOutbox] Message moved to DLQ after exception exhausted retries'"
    );
  });

  test('retry-exhausted logger.error includes orderId field', () => {
    // Find the retry-exhausted logger block and verify orderId is in its context
    const retryBlock = src.indexOf(
      'Message moved to DLQ after max retries'
    );
    expect(retryBlock).toBeGreaterThan(-1);
    // Check the context object following the message includes orderId
    const blockSlice = src.substring(retryBlock, retryBlock + 200);
    expect(blockSlice).toContain('orderId');
  });

  test('retry-exhausted logger.error includes attempts field', () => {
    const retryBlock = src.indexOf(
      'Message moved to DLQ after max retries'
    );
    const blockSlice = src.substring(retryBlock, retryBlock + 200);
    expect(blockSlice).toContain('attempts');
  });

  test('retry-exhausted logger.error includes maxAttempts field', () => {
    const retryBlock = src.indexOf(
      'Message moved to DLQ after max retries'
    );
    const blockSlice = src.substring(retryBlock, retryBlock + 200);
    expect(blockSlice).toContain('maxAttempts');
  });

  test('retry-exhausted logger.error includes lastError field', () => {
    const retryBlock = src.indexOf(
      'Message moved to DLQ after max retries'
    );
    const blockSlice = src.substring(retryBlock, retryBlock + 200);
    expect(blockSlice).toContain('lastError');
  });

  test('exception-exhausted logger.error includes orderId field', () => {
    const exBlock = src.indexOf(
      'Message moved to DLQ after exception exhausted retries'
    );
    expect(exBlock).toBeGreaterThan(-1);
    const blockSlice = src.substring(exBlock, exBlock + 200);
    expect(blockSlice).toContain('orderId');
  });

  test('exception-exhausted logger.error includes attempts field', () => {
    const exBlock = src.indexOf(
      'Message moved to DLQ after exception exhausted retries'
    );
    const blockSlice = src.substring(exBlock, exBlock + 200);
    expect(blockSlice).toContain('attempts');
  });

  test('exception-exhausted logger.error includes lastError field', () => {
    const exBlock = src.indexOf(
      'Message moved to DLQ after exception exhausted retries'
    );
    const blockSlice = src.substring(exBlock, exBlock + 200);
    expect(blockSlice).toContain('lastError');
  });
});

// =============================================================================
// GROUP 3: ADMIN RE-DRIVE ROUTE -- existence, auth, role guard
// =============================================================================
describe('GROUP 3: Admin re-drive route -- endpoint contract', () => {
  let routesSrc: string;

  beforeAll(() => {
    routesSrc = readSource(ADMIN_ROUTES_PATH);
  });

  test('POST /dispatch-outbox/:orderId/retry route is registered', () => {
    expect(routesSrc).toContain(
      "router.post('/dispatch-outbox/:orderId/retry'"
    );
  });

  test('authMiddleware is applied to all admin routes', () => {
    expect(routesSrc).toContain('router.use(authMiddleware)');
  });

  test('roleGuard([\'admin\']) is applied to all admin routes', () => {
    // Must restrict to admin role only
    expect(routesSrc).toMatch(/roleGuard\(\s*\[\s*['"]admin['"]\s*\]\s*\)/);
  });

  test('authMiddleware is imported from auth.middleware', () => {
    expect(routesSrc).toMatch(
      /import\s*\{[^}]*authMiddleware[^}]*\}\s*from\s*['"].*auth\.middleware['"]/
    );
  });

  test('roleGuard is imported from auth.middleware', () => {
    expect(routesSrc).toMatch(
      /import\s*\{[^}]*roleGuard[^}]*\}\s*from\s*['"].*auth\.middleware['"]/
    );
  });

  test('redriveDispatchOutbox handler is imported from admin.controller', () => {
    expect(routesSrc).toMatch(
      /import\s*\{[^}]*redriveDispatchOutbox[^}]*\}\s*from\s*['"]\.\/admin\.controller['"]/
    );
  });

  test('authMiddleware is applied BEFORE route definitions', () => {
    const authPos = routesSrc.indexOf('router.use(authMiddleware)');
    const routePos = routesSrc.indexOf("router.post('/dispatch-outbox/");
    expect(authPos).toBeGreaterThan(-1);
    expect(routePos).toBeGreaterThan(-1);
    expect(authPos).toBeLessThan(routePos);
  });

  test('roleGuard is applied BEFORE route definitions', () => {
    const guardPos = routesSrc.indexOf('roleGuard');
    const routePos = routesSrc.indexOf("router.post('/dispatch-outbox/");
    expect(guardPos).toBeGreaterThan(-1);
    expect(routePos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(routePos);
  });
});

// =============================================================================
// GROUP 4: ADMIN CONTROLLER -- redriveDispatchOutbox handler
// =============================================================================
describe('GROUP 4: Admin controller -- redriveDispatchOutbox handler', () => {
  let ctrlSrc: string;

  beforeAll(() => {
    ctrlSrc = readSource(ADMIN_CONTROLLER_PATH);
  });

  test('redriveDispatchOutbox function is exported', () => {
    expect(ctrlSrc).toMatch(
      /export\s+async\s+function\s+redriveDispatchOutbox/
    );
  });

  test('handler validates orderId is present and non-empty', () => {
    // Must check for missing or empty orderId
    expect(ctrlSrc).toMatch(/orderId.*trim\(\)\.length\s*===\s*0/);
  });

  test('handler returns 400 for missing orderId', () => {
    expect(ctrlSrc).toContain("res.status(400)");
    expect(ctrlSrc).toContain("'VALIDATION_ERROR'");
  });

  test('handler returns 404 when no failed row exists', () => {
    // When redriveFailedDispatch returns null -> 404
    const fnBlock = extractFunctionBlock(ctrlSrc, 'redriveDispatchOutbox');
    expect(fnBlock).toContain('res.status(404)');
    expect(fnBlock).toContain("'NOT_FOUND'");
  });

  test('handler returns success with orderId, status, and attempts on 200', () => {
    const fnBlock = extractFunctionBlock(ctrlSrc, 'redriveDispatchOutbox');
    expect(fnBlock).toContain('success: true');
    expect(fnBlock).toContain('updated.orderId');
    expect(fnBlock).toContain('updated.status');
    expect(fnBlock).toContain('updated.attempts');
  });

  test('handler calls redriveFailedDispatch from outbox service', () => {
    expect(ctrlSrc).toContain(
      "import { redriveFailedDispatch } from '../order/order-dispatch-outbox.service'"
    );
    const fnBlock = extractFunctionBlock(ctrlSrc, 'redriveDispatchOutbox');
    expect(fnBlock).toContain('redriveFailedDispatch(');
  });

  test('handler logs on successful re-drive', () => {
    const fnBlock = extractFunctionBlock(ctrlSrc, 'redriveDispatchOutbox');
    expect(fnBlock).toContain("logger.info('[AdminController] Dispatch outbox re-driven'");
  });

  test('handler forwards errors via next(error)', () => {
    const fnBlock = extractFunctionBlock(ctrlSrc, 'redriveDispatchOutbox');
    expect(fnBlock).toContain('next(error)');
  });
});

// =============================================================================
// GROUP 5: redriveFailedDispatch -- behavioral edge cases
// =============================================================================
describe('GROUP 5: redriveFailedDispatch -- reset logic & edge cases', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('redriveFailedDispatch function is exported', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+redriveFailedDispatch/
    );
  });

  test('returns null when no row exists for orderId', () => {
    // Function must look up by orderId and return null if not found
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('return null');
  });

  test('returns null when row exists but status is NOT failed', () => {
    // Only failed rows should be re-driveable
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toMatch(/row\.status\s*!==\s*['"]failed['"]/);
  });

  test('resets status to pending on re-drive', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toMatch(/status:\s*['"]pending['"]/);
  });

  test('resets attempts to 0 on re-drive', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('attempts: 0');
  });

  test('clears lastError on re-drive', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('lastError: null');
  });

  test('clears processedAt on re-drive', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('processedAt: null');
  });

  test('clears lockedAt on re-drive', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('lockedAt: null');
  });

  test('sets nextRetryAt to now (immediate retry)', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('nextRetryAt: new Date()');
  });

  test('logs previous attempts and error for audit trail', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('previousAttempts');
    expect(fnBlock).toContain('previousError');
  });

  test('emits dispatch_dlq_redrive_total metric after successful re-drive', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain("dispatch_dlq_redrive_total");
  });
});

// =============================================================================
// GROUP 6: processDispatchOutboxRow -- retry exhaustion DLQ path
// =============================================================================
describe('GROUP 6: processDispatchOutboxRow -- retry-exhaustion DLQ', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('sets status to failed when retry exhausted', () => {
    // When DISPATCH_RETRYING reason hits maxAttempts, status becomes failed
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    // The retrying path that becomes failed:
    expect(fnBlock).toContain("lastError: 'DISPATCH_RETRY_EXHAUSTED'");
    expect(fnBlock).toContain("status: 'failed'");
  });

  test('sets processedAt when moving to DLQ (retry exhausted)', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    // In the retry-exhausted branch, processedAt must be set
    expect(fnBlock).toContain('processedAt: new Date()');
  });

  test('clears lockedAt when moving to DLQ', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    expect(fnBlock).toContain('lockedAt: null');
  });

  test('DLQ metric fires AFTER db update (retry path)', () => {
    // The metric should come after the update call, not before
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const updatePos = fnBlock.indexOf("'DISPATCH_RETRY_EXHAUSTED'");
    const metricPos = fnBlock.indexOf(
      "dispatch_dlq_total', { orderId: resolvedOrderId, reason: 'RETRY_EXHAUSTED'"
    );
    expect(updatePos).toBeGreaterThan(-1);
    expect(metricPos).toBeGreaterThan(-1);
    // Metric must be emitted after the DB update block
    expect(metricPos).toBeGreaterThan(updatePos);
  });

  test('shouldRetry is false when attemptNumber >= maxAttempts', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    // The condition: attemptNumber < row.maxAttempts determines shouldRetry
    expect(fnBlock).toMatch(/attemptNumber\s*<\s*row\.maxAttempts/);
  });

  test('sets finalReasonCode to DISPATCH_FAILED when retry exhausted', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    expect(fnBlock).toContain("finalReasonCode = 'DISPATCH_FAILED'");
  });
});

// =============================================================================
// GROUP 7: processDispatchOutboxRow -- exception exhaustion DLQ path
// =============================================================================
describe('GROUP 7: processDispatchOutboxRow -- exception-exhaustion DLQ', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('catch block determines retryable from attemptNumber < maxAttempts', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    // In catch block: const retryable = attemptNumber < row.maxAttempts
    expect(fnBlock).toMatch(/retryable\s*=\s*attemptNumber\s*<\s*row\.maxAttempts/);
  });

  test('non-retryable exception path sets status to failed', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    // The catch block has both retrying and failed paths
    // We verify the failed path is present (for non-retryable)
    const catchBlock = fnBlock.substring(
      fnBlock.lastIndexOf('catch (error')
    );
    expect(catchBlock).toContain("status: 'failed'");
  });

  test('non-retryable exception sets processedAt', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const catchBlock = fnBlock.substring(
      fnBlock.lastIndexOf('catch (error')
    );
    expect(catchBlock).toContain('processedAt: new Date()');
  });

  test('DLQ metric fires ONLY when NOT retryable (!retryable guard)', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const catchBlock = fnBlock.substring(
      fnBlock.lastIndexOf('catch (error')
    );
    // The guard: if (!retryable) { metrics.incrementCounter ... }
    expect(catchBlock).toContain('if (!retryable)');
    expect(catchBlock).toContain('dispatch_dlq_total');
  });

  test('exception DLQ metric includes EXCEPTION_EXHAUSTED reason', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const catchBlock = fnBlock.substring(
      fnBlock.lastIndexOf('catch (error')
    );
    expect(catchBlock).toContain("reason: 'EXCEPTION_EXHAUSTED'");
  });

  test('retryable exception path sets status to retrying (NOT failed)', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const catchBlock = fnBlock.substring(
      fnBlock.lastIndexOf('catch (error')
    );
    expect(catchBlock).toContain("status: 'retrying'");
  });

  test('retryable exception calculates exponential backoff for nextRetryAt', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const catchBlock = fnBlock.substring(
      fnBlock.lastIndexOf('catch (error')
    );
    expect(catchBlock).toContain('calculateDispatchRetryDelayMs');
  });

  test('error message is captured from thrown Error or fallback string', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const catchBlock = fnBlock.substring(
      fnBlock.lastIndexOf('catch (error')
    );
    // Must extract message safely from unknown error
    expect(catchBlock).toMatch(
      /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:/
    );
  });
});

// =============================================================================
// GROUP 8: CONCURRENT RE-DRIVE SAFETY
// =============================================================================
describe('GROUP 8: Concurrent re-drive safety', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('redriveFailedDispatch uses findUnique (single row lookup, not findMany)', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toContain('.findUnique(');
    expect(fnBlock).not.toContain('.findMany(');
  });

  test('redriveFailedDispatch updates by orderId (unique constraint)', () => {
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toMatch(/update\(\s*\{[^}]*where:\s*\{\s*orderId\s*\}/s);
  });

  test('re-drive only operates on status === failed (rejects pending/processing/retrying)', () => {
    // The guard: if (!row || row.status !== 'failed') return null
    const fnBlock = extractFunctionBlock(src, 'redriveFailedDispatch');
    expect(fnBlock).toMatch(/!row\s*\|\|\s*row\.status\s*!==\s*['"]failed['"]/);
  });

  test('claimReadyDispatchOutboxRows uses FOR UPDATE SKIP LOCKED for row-level locking', () => {
    // Prevents two workers from claiming the same row
    expect(src).toContain('FOR UPDATE SKIP LOCKED');
  });

  test('stale lock detection uses 120s threshold', () => {
    // Rows locked > 120s can be reclaimed
    expect(src).toContain('120_000');
  });
});

// =============================================================================
// GROUP 9: OUTBOX ROW LIFECYCLE EDGE CASES
// =============================================================================
describe('GROUP 9: Outbox row lifecycle edge cases', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('ORDER_NOT_FOUND sets status to failed and returns immediately', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    expect(fnBlock).toContain("lastError: 'ORDER_NOT_FOUND'");
    expect(fnBlock).toContain("dispatchState: 'dispatch_failed'");
    expect(fnBlock).toContain("reasonCode: 'ORDER_NOT_FOUND'");
  });

  test('ORDER_INACTIVE sets status to failed and persists snapshot', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    expect(fnBlock).toContain("lastError: 'ORDER_INACTIVE'");
    expect(fnBlock).toContain('persistOrderDispatchSnapshot');
  });

  test('parseDispatchOutboxPayload returns null for non-object payload', () => {
    expect(src).toContain(
      'if (!payload || typeof payload !== \'object\' || Array.isArray(payload))'
    );
  });

  test('parseDispatchOutboxPayload returns null for empty orderId', () => {
    expect(src).toContain("if (!orderId) return null");
  });

  test('enqueueOrderDispatchOutbox uses upsert (idempotent enqueue)', () => {
    const fnBlock = extractFunctionBlock(src, 'enqueueOrderDispatchOutbox');
    expect(fnBlock).toContain('.upsert(');
  });

  test('enqueue sets maxAttempts to 8 on create', () => {
    const fnBlock = extractFunctionBlock(src, 'enqueueOrderDispatchOutbox');
    expect(fnBlock).toContain('maxAttempts: 8');
  });

  test('processDispatchOutboxBatch skips when feature flag is off', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxBatch');
    expect(fnBlock).toContain('if (!FF_ORDER_DISPATCH_OUTBOX) return');
  });

  test('calculateDispatchRetryDelayMs caps at 60 seconds', () => {
    const fnBlock = extractFunctionBlock(src, 'calculateDispatchRetryDelayMs');
    expect(fnBlock).toContain('60_000');
  });

  test('calculateDispatchRetryDelayMs adds jitter (max 750ms)', () => {
    const fnBlock = extractFunctionBlock(src, 'calculateDispatchRetryDelayMs');
    expect(fnBlock).toContain('750');
  });
});

// =============================================================================
// GROUP 10: DLQ PATH COMPLETENESS -- no silent failures
// =============================================================================
describe('GROUP 10: DLQ path completeness -- no silent failures', () => {
  let src: string;

  beforeAll(() => {
    src = readSource(OUTBOX_SERVICE_PATH);
  });

  test('every status=failed write in processDispatchOutboxRow has a lastError value', () => {
    // Extract all status: 'failed' blocks and ensure lastError is never missing
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const failedBlocks = fnBlock.split("status: 'failed'");
    // First element is before any match, rest are after each match
    for (let i = 1; i < failedBlocks.length; i++) {
      const surrounding = failedBlocks[i].substring(0, 200);
      expect(surrounding).toContain('lastError');
    }
  });

  test('every status=failed write in processDispatchOutboxRow sets lockedAt to null', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    const failedBlocks = fnBlock.split("status: 'failed'");
    for (let i = 1; i < failedBlocks.length; i++) {
      const surrounding = failedBlocks[i].substring(0, 200);
      expect(surrounding).toContain('lockedAt: null');
    }
  });

  test('outbox worker catches errors per-row (does not abort batch on single row failure)', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxBatch');
    expect(fnBlock).toContain('try {');
    expect(fnBlock).toContain('catch (error');
    // The per-row try/catch should be inside the for loop
    expect(fnBlock).toContain('for (const row of rows)');
  });

  test('outbox worker logs orderId on per-row failure', () => {
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxBatch');
    expect(fnBlock).toContain('orderId: row.orderId');
  });

  test('NO_ONLINE_TRANSPORTERS path sets status to failed (not retrying)', () => {
    // When zero transporters are online, retrying is pointless per dispatch cycle
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    expect(fnBlock).toContain("lastError: 'NO_ONLINE_TRANSPORTERS'");
  });

  test('dispatched path clears lastError to null', () => {
    // On success, previous errors should be cleared
    const fnBlock = extractFunctionBlock(src, 'processDispatchOutboxRow');
    // The dispatched update block
    expect(fnBlock).toContain("status: 'dispatched'");
    // Find the dispatched block and verify lastError: null
    const dispatchedIdx = fnBlock.indexOf("status: 'dispatched'");
    const dispatchedSlice = fnBlock.substring(dispatchedIdx, dispatchedIdx + 200);
    expect(dispatchedSlice).toContain('lastError: null');
  });
});

// =============================================================================
// HELPER: Extract a named function block from source code
// =============================================================================
function extractFunctionBlock(source: string, fnName: string): string {
  // Find the function signature
  const patterns = [
    new RegExp(`export\\s+async\\s+function\\s+${fnName}\\s*\\(`),
    new RegExp(`export\\s+function\\s+${fnName}\\s*\\(`),
    new RegExp(`async\\s+function\\s+${fnName}\\s*\\(`),
    new RegExp(`function\\s+${fnName}\\s*\\(`),
  ];

  let startIdx = -1;
  for (const p of patterns) {
    const match = p.exec(source);
    if (match) {
      startIdx = match.index;
      break;
    }
  }

  if (startIdx === -1) {
    return `[FUNCTION ${fnName} NOT FOUND]`;
  }

  // Walk forward matching braces to find the end of the function
  const openBrace = source.indexOf('{', startIdx);
  if (openBrace === -1) return source.substring(startIdx);

  let depth = 0;
  let endIdx = openBrace;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) {
      endIdx = i + 1;
      break;
    }
  }

  return source.substring(startIdx, endIdx);
}
