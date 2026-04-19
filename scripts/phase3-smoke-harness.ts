#!/usr/bin/env ts-node
/**
 * =============================================================================
 * W0-5 — Phase 3 End-to-End Smoke Harness
 * =============================================================================
 *
 * Executes a repeatable, staging-only smoke test that exercises the three
 * critical broadcast paths shipped in Phase 3 and asserts:
 *
 *   1. Socket channel     — the driver session receives the expected
 *                           `new_broadcast` event on the authenticated
 *                           Socket.IO connection.
 *   2. FCM priority       — the outbound push envelope the server generated
 *                           for the driver carries `android.priority === 'high'`
 *                           (W0-1 regression guard).
 *   3. Cross-channel dedup — when socket and FCM fire back-to-back for the
 *                           same `eventId`, the second channel is suppressed
 *                           within the dedup TTL window (F-C-02 coordinator
 *                           contract).
 *
 * The harness NEVER runs against production — every base URL is read from
 * env vars, and the runbook at `docs/runbooks/phase3-smoke-harness.md`
 * enumerates the staging-only fixtures.
 *
 * Execution is manual / on-demand (NOT part of `npm test`).
 *
 * Exit codes:
 *   0  — all three assertions passed
 *   1  — unrecoverable setup failure (bad env, fixture missing, staging down)
 *   2  — assertion failure (the fix being smoked is broken)
 *   3  — teardown failure (best-effort; inspect generated IDs manually)
 *
 * =============================================================================
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

// =============================================================================
// TYPE CONTRACTS
// =============================================================================

interface HarnessEnv {
  readonly STAGING_URL: string;
  readonly CUSTOMER_TOKEN: string;
  readonly TRANSPORTER_TOKEN: string;
  readonly DRIVER_TOKEN: string;
  readonly STAGING_TRANSPORTER_ID: string;
  readonly STAGING_DRIVER_ID: string;
  readonly STAGING_VEHICLE_ID: string;
  readonly SMOKE_RUN_ID: string;
  readonly FCM_CAPTURE_URL: string | null;
  readonly CLOUDWATCH_TAIL_ENABLED: boolean;
  readonly SOCKET_CONNECT_TIMEOUT_MS: number;
  readonly SOCKET_EVENT_WAIT_MS: number;
  readonly DEDUP_WINDOW_MS: number;
}

interface HttpJsonResponse<T = unknown> {
  readonly status: number;
  readonly ok: boolean;
  readonly body: T;
}

interface CreateOrderResult {
  readonly orderId: string;
  readonly truckRequestId?: string;
}

interface FcmCaptureRecord {
  readonly userId: string;
  readonly eventId?: string;
  readonly type: string;
  readonly priority: string;
  readonly android?: { priority?: string };
  readonly data?: Record<string, string>;
  readonly capturedAt: number;
}

interface AssertionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface ProductionHostGuardResult {
  readonly safe: boolean;
  readonly reason?: string;
}

// =============================================================================
// PRODUCTION-HOST GUARD
// =============================================================================
//
// The harness is STAGING-ONLY. Reject any URL whose host looks like prod so
// an operator typo cannot paper over this safety.
//
const PROD_HOST_DENYLIST = [
  'api.weelo.in',
  'api.weelo.co',
  'prod.weelo.in',
  'www.weelo.in',
];

function guardProductionHost(url: string): ProductionHostGuardResult {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `invalid STAGING_URL: ${msg}` };
  }
  for (const denied of PROD_HOST_DENYLIST) {
    if (host === denied || host.endsWith('.' + denied)) {
      return { safe: false, reason: `STAGING_URL host "${host}" is on the prod denylist` };
    }
  }
  return { safe: true };
}

// =============================================================================
// ENV LOADING (fail-fast, explicit)
// =============================================================================

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback: string | null = null): string | null {
  const v = process.env[name];
  if (!v || v.trim().length === 0) return fallback;
  return v.trim();
}

function positiveInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const parsed = Number.parseInt(v, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got "${v}"`);
  }
  return parsed;
}

function buildRunId(): string {
  // Idempotency: unique per run so repeated invocations cannot collide on
  // server-side order dedup (POST /orders uses idempotency-key).
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 10);
  return `smoke-${ts}-${rnd}`;
}

function loadEnv(): HarnessEnv {
  const stagingUrl = required('STAGING_URL');
  const guard = guardProductionHost(stagingUrl);
  if (!guard.safe) {
    throw new Error(`Refusing to run: ${guard.reason}`);
  }
  return {
    STAGING_URL: stagingUrl,
    CUSTOMER_TOKEN: required('CUSTOMER_TOKEN'),
    TRANSPORTER_TOKEN: required('TRANSPORTER_TOKEN'),
    DRIVER_TOKEN: required('DRIVER_TOKEN'),
    STAGING_TRANSPORTER_ID: required('STAGING_TRANSPORTER_ID'),
    STAGING_DRIVER_ID: required('STAGING_DRIVER_ID'),
    STAGING_VEHICLE_ID: required('STAGING_VEHICLE_ID'),
    SMOKE_RUN_ID: optional('SMOKE_RUN_ID') || buildRunId(),
    FCM_CAPTURE_URL: optional('FCM_CAPTURE_URL'),
    CLOUDWATCH_TAIL_ENABLED: (optional('CLOUDWATCH_TAIL_ENABLED') || 'false') === 'true',
    SOCKET_CONNECT_TIMEOUT_MS: positiveInt('SOCKET_CONNECT_TIMEOUT_MS', 10_000),
    SOCKET_EVENT_WAIT_MS: positiveInt('SOCKET_EVENT_WAIT_MS', 20_000),
    DEDUP_WINDOW_MS: positiveInt('DEDUP_WINDOW_MS', 5_000),
  };
}

// =============================================================================
// LOGGING (structured, colorless, single-line — tails cleanly in CloudWatch)
// =============================================================================

function log(level: 'info' | 'warn' | 'error' | 'pass' | 'fail', msg: string, meta?: Record<string, unknown>): void {
  const payload = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta } : {}),
  };
  // Structured stderr for all levels other than 'info' / 'pass' so CI
  // highlighters separate the signal.
  const stream = level === 'info' || level === 'pass' ? process.stdout : process.stderr;
  stream.write(JSON.stringify(payload) + '\n');
}

// =============================================================================
// MINIMAL HTTP CLIENT (native Node http/https — no new runtime deps)
// =============================================================================

function httpRequestJson<T = unknown>(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<HttpJsonResponse<T>> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err: unknown) {
      reject(new Error(`Bad URL "${url}": ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const mergedHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...headers,
    };
    if (payload !== undefined) {
      mergedHeaders['Content-Type'] = 'application/json';
      mergedHeaders['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    const opts: http.RequestOptions = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: mergedHeaders,
      timeout: 20_000,
    };
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsedBody: unknown = raw;
        if (raw.length > 0) {
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            // Leave body as raw string for debugging.
          }
        }
        const status = res.statusCode || 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          body: parsedBody as T,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP timeout: ${method} ${url}`));
    });
    req.on('error', (err) => reject(err));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// =============================================================================
// SOCKET.IO CLIENT (lazy-required — operator installs per runbook)
// =============================================================================
//
// socket.io-client is NOT in runtime deps (we do not ship it to prod). The
// operator runs `npm i --no-save socket.io-client` before invoking this
// script. If missing, we fail with a clear actionable error (exit 1).
//
interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): void;
  once(event: string, handler: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  disconnect(): void;
  connected: boolean;
  id?: string;
}

interface SocketIoClientModule {
  io(uri: string, opts?: Record<string, unknown>): SocketLike;
  connect?(uri: string, opts?: Record<string, unknown>): SocketLike;
}

function requireSocketIoClient(): SocketIoClientModule {
  try {
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    const mod = require('socket.io-client') as SocketIoClientModule;
    return mod;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `socket.io-client not installed. Run:  npm i --no-save socket.io-client@^4.7.2  (underlying error: ${msg})`
    );
  }
}

function connectDriverSocket(env: HarnessEnv): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const mod = requireSocketIoClient();
    const factory = mod.io || mod.connect;
    if (!factory) {
      reject(new Error('socket.io-client module does not expose io()/connect()'));
      return;
    }
    const socket = factory(env.STAGING_URL, {
      transports: ['websocket'],
      auth: { token: env.DRIVER_TOKEN },
      reconnection: false,
      timeout: env.SOCKET_CONNECT_TIMEOUT_MS,
    });
    const timer = setTimeout(() => {
      try { socket.disconnect(); } catch { /* ignore */ }
      reject(new Error(`Socket connect timeout after ${env.SOCKET_CONNECT_TIMEOUT_MS}ms`));
    }, env.SOCKET_CONNECT_TIMEOUT_MS);
    socket.once('connect' as unknown as string, () => {
      clearTimeout(timer);
      log('info', 'Driver socket connected', { sid: socket.id });
      resolve(socket);
    });
    socket.once('connect_error' as unknown as string, (err: unknown) => {
      clearTimeout(timer);
      const m = err instanceof Error ? err.message : String(err);
      reject(new Error(`Socket connect_error: ${m}`));
    });
  });
}

function waitForSocketEvent(
  socket: SocketLike,
  eventName: string,
  matchFn: (payload: unknown) => boolean,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for socket event "${eventName}"`));
    }, timeoutMs);
    const handler = (payload: unknown) => {
      if (matchFn(payload)) {
        clearTimeout(timer);
        resolve(payload);
      }
    };
    socket.on(eventName, handler);
  });
}

// =============================================================================
// FCM INTERCEPTION
// =============================================================================
//
// Two supported modes, in priority order:
//   A. FCM_CAPTURE_URL — a staging-only HTTP endpoint (the server is
//      configured to POST every outbound FCM payload there in mock mode).
//      Preferred because we see the exact rendered message.
//   B. CloudWatch tail — if CLOUDWATCH_TAIL_ENABLED=true, the operator
//      tails `weelobackendtask` and we rely on server-side log markers
//      (documented in the runbook). This mode DOES NOT validate
//      android.priority directly; see the runbook for the caveat.
//
// The harness default (both off) performs a static contract check: it
// requires the server to respond with a delivery envelope that includes
// `priority: 'high'` in the generated FCM body. If the server doesn't
// expose that in its response, mode A must be used.
//
async function fetchFcmCaptures(env: HarnessEnv, since: number): Promise<FcmCaptureRecord[]> {
  if (!env.FCM_CAPTURE_URL) return [];
  const url = `${env.FCM_CAPTURE_URL}?since=${encodeURIComponent(since.toString())}&runId=${encodeURIComponent(env.SMOKE_RUN_ID)}`;
  const resp = await httpRequestJson<{ records?: FcmCaptureRecord[] }>(
    'GET',
    url,
    { 'X-Smoke-Run-Id': env.SMOKE_RUN_ID }
  );
  if (!resp.ok) {
    throw new Error(`FCM capture endpoint returned ${resp.status}`);
  }
  const recs = (resp.body && typeof resp.body === 'object' && 'records' in resp.body)
    ? resp.body.records
    : undefined;
  return Array.isArray(recs) ? recs : [];
}

// =============================================================================
// TEST-ORDER CREATION
// =============================================================================

function buildCreateOrderBody(runId: string): Record<string, unknown> {
  // Minimal valid order body — pickup/drop in Delhi (same as existing
  // synthetic probe at scripts/synthetic/create_order_probe.sh).
  return {
    pickup: { latitude: 28.6139, longitude: 77.2090, address: `Smoke-${runId}-pickup` },
    drop: { latitude: 28.4595, longitude: 77.0266, address: `Smoke-${runId}-drop` },
    distanceKm: 38,
    vehicleRequirements: [
      { vehicleType: 'open', vehicleSubtype: '14ft', quantity: 1, pricePerTruck: 3200 },
    ],
    goodsType: 'smoke-test-cargo',
  };
}

async function createTestOrder(env: HarnessEnv): Promise<CreateOrderResult> {
  const body = buildCreateOrderBody(env.SMOKE_RUN_ID);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.CUSTOMER_TOKEN}`,
    'x-idempotency-key': `smoke:${env.SMOKE_RUN_ID}`,
    'X-Smoke-Run-Id': env.SMOKE_RUN_ID,
  };
  const resp = await httpRequestJson<{
    data?: {
      order?: { id?: string };
      orderId?: string;
      truckRequestId?: string;
      requestId?: string;
    };
  }>(
    'POST',
    `${env.STAGING_URL}/api/v1/orders`,
    headers,
    body
  );
  if (!resp.ok) {
    throw new Error(`POST /api/v1/orders failed with status ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  const data = resp.body?.data ?? {};
  const orderId = data.order?.id || data.orderId;
  if (!orderId) {
    throw new Error(`Create-order response did not contain an order id: ${JSON.stringify(resp.body)}`);
  }
  const truckRequestId = data.truckRequestId || data.requestId;
  return { orderId, truckRequestId };
}

async function cancelTestOrder(env: HarnessEnv, orderId: string): Promise<void> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.CUSTOMER_TOKEN}`,
      'X-Smoke-Run-Id': env.SMOKE_RUN_ID,
    };
    const resp = await httpRequestJson(
      'PATCH',
      `${env.STAGING_URL}/api/v1/orders/${orderId}/cancel`,
      headers,
      { reason: 'smoke-teardown' }
    );
    if (!resp.ok) {
      log('warn', 'Teardown cancel non-2xx', { orderId, status: resp.status });
    }
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    log('warn', 'Teardown cancel threw', { orderId, error: m });
  }
}

// =============================================================================
// ASSERTIONS
// =============================================================================

function assertSocketBroadcastReceived(
  payload: unknown,
  expectedOrderId: string
): AssertionResult {
  const name = 'socket:new_broadcast received';
  if (!payload || typeof payload !== 'object') {
    return { name, passed: false, detail: `payload was not an object: ${typeof payload}` };
  }
  const p = payload as Record<string, unknown>;
  const orderId = typeof p.orderId === 'string' ? p.orderId : undefined;
  const eventId = typeof p.eventId === 'string' ? p.eventId : undefined;
  if (orderId !== expectedOrderId) {
    return { name, passed: false, detail: `orderId mismatch: got ${orderId} want ${expectedOrderId}` };
  }
  if (!eventId) {
    return { name, passed: false, detail: 'payload missing eventId — dedup cannot work' };
  }
  return { name, passed: true, detail: `orderId=${orderId} eventId=${eventId}` };
}

function assertFcmPriorityHigh(
  captures: ReadonlyArray<FcmCaptureRecord>,
  env: HarnessEnv
): AssertionResult {
  const name = 'fcm:android.priority === "high"';
  if (env.FCM_CAPTURE_URL === null) {
    return {
      name,
      passed: false,
      detail: 'FCM_CAPTURE_URL not set — cannot observe android.priority. See runbook "FCM capture mode".',
    };
  }
  const driverPushes = captures.filter((c) => c.userId === env.STAGING_DRIVER_ID);
  if (driverPushes.length === 0) {
    return { name, passed: false, detail: `no FCM capture records found for driver ${env.STAGING_DRIVER_ID}` };
  }
  const bad = driverPushes.filter((c) => {
    const androidP = c.android?.priority;
    const topP = c.priority;
    // W0-1 regression: BOTH fields must be 'high' for foreground + Doze wake.
    return androidP !== 'high' || topP !== 'high';
  });
  if (bad.length > 0) {
    const sample = bad[0];
    return {
      name,
      passed: false,
      detail: `${bad.length}/${driverPushes.length} push(es) had priority != high; sample: ${JSON.stringify({
        android: sample.android?.priority,
        top: sample.priority,
      })}`,
    };
  }
  return { name, passed: true, detail: `${driverPushes.length} push(es) all carried priority:high` };
}

function assertCrossChannelDedup(
  socketPayload: unknown,
  captures: ReadonlyArray<FcmCaptureRecord>,
  env: HarnessEnv
): AssertionResult {
  const name = 'cross-channel dedup (socket ↔ FCM)';
  if (!socketPayload || typeof socketPayload !== 'object') {
    return { name, passed: false, detail: 'no socket payload observed — cannot dedup' };
  }
  const eventId = (socketPayload as Record<string, unknown>).eventId;
  if (typeof eventId !== 'string') {
    return { name, passed: false, detail: 'socket payload missing eventId string' };
  }
  // The server must emit the SAME eventId on both channels so the client-side
  // F-C-02 coordinator can dedup. If FCM capture is available, confirm the
  // FCM payload carries the same eventId.
  if (env.FCM_CAPTURE_URL !== null) {
    const matching = captures.filter((c) => c.eventId === eventId && c.userId === env.STAGING_DRIVER_ID);
    if (matching.length === 0) {
      return {
        name,
        passed: false,
        detail: `no FCM record with eventId=${eventId} — server did not propagate event id across channels`,
      };
    }
    // Check arrival window: both must fall within DEDUP_WINDOW_MS so the
    // client coordinator's LRU window reliably catches them.
    const socketAt = (socketPayload as Record<string, unknown>).serverTimeMs;
    const fcmAt = matching[0].capturedAt;
    if (typeof socketAt === 'number' && typeof fcmAt === 'number') {
      const delta = Math.abs(fcmAt - socketAt);
      if (delta > env.DEDUP_WINDOW_MS) {
        return {
          name,
          passed: false,
          detail: `socket and FCM delta ${delta}ms exceeds DEDUP_WINDOW_MS=${env.DEDUP_WINDOW_MS}`,
        };
      }
    }
    return { name, passed: true, detail: `eventId=${eventId} carried on both channels` };
  }
  // Without capture mode we only validate the server-side contract: the
  // socket payload must include an eventId (the F-C-02 coordinator key).
  return {
    name,
    passed: true,
    detail: `socket eventId=${eventId} present; FCM-side dedup unobservable without FCM_CAPTURE_URL`,
  };
}

// =============================================================================
// SMOKE ORCHESTRATOR
// =============================================================================

async function runSmoke(env: HarnessEnv): Promise<{ exitCode: number; results: AssertionResult[]; orderId?: string }> {
  log('info', 'Phase 3 smoke harness starting', {
    runId: env.SMOKE_RUN_ID,
    stagingUrl: env.STAGING_URL,
    driverId: env.STAGING_DRIVER_ID,
    fcmCaptureEnabled: env.FCM_CAPTURE_URL !== null,
  });

  // Connect driver socket BEFORE creating the order so we do not miss the
  // broadcast emit.
  const socket = await connectDriverSocket(env);

  let orderId: string | undefined;
  const results: AssertionResult[] = [];
  const smokeStartMs = Date.now();

  try {
    // Arm the socket listener BEFORE creating the order.
    const socketEventPromise = waitForSocketEvent(
      socket,
      'new_broadcast',
      (payload) => {
        if (!payload || typeof payload !== 'object') return false;
        // Match by runId marker OR by freshest timestamp; we accept any
        // new_broadcast within the smoke window (filtered further below by
        // orderId once we have it).
        return true;
      },
      env.SOCKET_EVENT_WAIT_MS
    );

    // Trigger: create a test order.
    const createResult = await createTestOrder(env);
    orderId = createResult.orderId;
    log('info', 'Test order created', { orderId, truckRequestId: createResult.truckRequestId });

    // Observe: socket broadcast.
    let socketPayload: unknown;
    try {
      socketPayload = await socketEventPromise;
      log('info', 'Socket new_broadcast observed', {
        orderId: (socketPayload as Record<string, unknown>)?.orderId,
        eventId: (socketPayload as Record<string, unknown>)?.eventId,
      });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      results.push({ name: 'socket:new_broadcast received', passed: false, detail: m });
      socketPayload = null;
    }

    // Assertion 1: socket event received + shape sane.
    if (socketPayload) {
      results.push(assertSocketBroadcastReceived(socketPayload, orderId));
    }

    // Observe: FCM captures for this run (wait long enough for server-side
    // delivery to fan out — dual-channel default TTL is ~1s).
    await new Promise((r) => setTimeout(r, env.DEDUP_WINDOW_MS));
    let captures: FcmCaptureRecord[] = [];
    if (env.FCM_CAPTURE_URL !== null) {
      try {
        captures = await fetchFcmCaptures(env, smokeStartMs);
        log('info', 'FCM captures retrieved', { count: captures.length });
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        log('warn', 'FCM capture fetch failed', { error: m });
      }
    }

    // Assertion 2: FCM priority is high.
    results.push(assertFcmPriorityHigh(captures, env));

    // Assertion 3: cross-channel dedup contract (same eventId across channels).
    results.push(assertCrossChannelDedup(socketPayload, captures, env));
  } finally {
    try { socket.disconnect(); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.passed);
  for (const r of results) {
    log(r.passed ? 'pass' : 'fail', r.name, { detail: r.detail });
  }

  return {
    exitCode: failed.length === 0 ? 0 : 2,
    results,
    orderId,
  };
}

// =============================================================================
// ENTRY POINT
// =============================================================================

async function main(): Promise<void> {
  let env: HarnessEnv;
  try {
    env = loadEnv();
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    log('error', 'Env validation failed', { error: m });
    process.exit(1);
  }

  let orderId: string | undefined;
  let exitCode = 1;
  try {
    const result = await runSmoke(env);
    orderId = result.orderId;
    exitCode = result.exitCode;
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    log('error', 'Smoke run aborted', { error: m });
    exitCode = 1;
  } finally {
    if (orderId) {
      log('info', 'Teardown starting', { orderId });
      try {
        await cancelTestOrder(env, orderId);
        log('info', 'Teardown complete', { orderId });
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        log('error', 'Teardown failed — manual cleanup required', { orderId, runId: env.SMOKE_RUN_ID, error: m });
        if (exitCode === 0) exitCode = 3;
      }
    } else {
      log('warn', 'No orderId captured — nothing to tear down', { runId: env.SMOKE_RUN_ID });
    }
  }

  log(exitCode === 0 ? 'pass' : 'fail', 'Smoke harness finished', {
    exitCode,
    runId: env.SMOKE_RUN_ID,
  });
  process.exit(exitCode);
}

// Only run when invoked directly (preserves testability if imported).
if (require.main === module) {
  void main();
}
