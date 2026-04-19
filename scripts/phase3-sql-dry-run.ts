#!/usr/bin/env ts-node
/**
 * =============================================================================
 * W0-2 — Phase 3 SQL Migration Dry-Run Harness
 * =============================================================================
 *
 * Purpose:
 *   Safely apply the two pending direct-SQL migrations to a THROWAWAY local
 *   Docker Postgres 15 container and verify:
 *     1. Both migrations succeed on a clean schema.
 *     2. Re-running both migrations is a no-op (idempotency).
 *     3. Pre-state and post-state diffs match the expectations documented in
 *        each SQL file's verification block.
 *
 * NON-GOALS / HARD CONSTRAINTS:
 *   - This script MUST NOT connect to prod, staging, or any remote RDS. The
 *     only allowed host is 127.0.0.1 / localhost on a port we open ourselves.
 *   - This script MUST NOT modify the SQL migration files.
 *   - This script MUST NOT modify prisma/schema.prisma.
 *   - No subagent spawned by any wave may run `psql` against prod. Humans only.
 *
 * Usage:
 *   # 1. Start Docker Desktop (or any local Docker daemon).
 *   # 2. From repo root:
 *   npx ts-node scripts/phase3-sql-dry-run.ts
 *
 *   # Exit codes:
 *   #   0 — all migrations applied cleanly and second-run is a no-op.
 *   #   1 — migration failed, idempotency check failed, or environment gap.
 *   #   2 — Docker or psql unavailable on the host (operator action needed).
 *
 * Design:
 *   - Uses `docker run` to spin up `postgres:15` with a random host port.
 *   - Uses `psql` on the host (via child_process) to bootstrap a minimal
 *     schema ("Order" + "User" tables) that matches the Prisma shape the
 *     migrations depend on.
 *   - Runs each migration twice; the second pass MUST touch 0 rows / no-op.
 *   - Verification assertions mirror the verification comments inside the
 *     two SQL files so the dry-run catches schema drift early.
 *   - Always tears down the container on exit (success OR failure).
 *
 * Why no `pg` npm dependency:
 *   - `pg` is not in this repo's dependency tree; this script is a one-off
 *     dry-run, not a runtime service, so adding a dep is overkill.
 *   - `psql` is available on the host (macOS Homebrew / Linux apt).
 *     Shelling out keeps the harness self-contained.
 * =============================================================================
 */

import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration — all values are local / synthetic. Nothing points at prod.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');
const F_A_02_SQL = path.join(MIGRATIONS_DIR, 'phase3-f-a-02-order-unique.sql');
const F_B_75_SQL = path.join(MIGRATIONS_DIR, 'phase3-f-b-75-kyc.sql');

const CONTAINER_NAME = `weelo-phase3-dryrun-${process.pid}`;
const POSTGRES_IMAGE = 'postgres:15';
const POSTGRES_PASSWORD = 'dryrun'; // local-only throwaway password
const POSTGRES_USER = 'postgres';
const POSTGRES_DB = 'weelo_dryrun';
// Random high port in 54000-55999 so parallel runs do not collide.
const HOST_PORT = 54000 + Math.floor(Math.random() * 2000);
const HOST = '127.0.0.1';

// How long to wait for Postgres to accept connections after container start.
const POSTGRES_STARTUP_TIMEOUT_MS = 30_000;
const POSTGRES_STARTUP_POLL_MS = 500;

// ---------------------------------------------------------------------------
// Result envelope — every step reports a structured PASS/FAIL.
// ---------------------------------------------------------------------------

interface StepResult {
  readonly step: string;
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  readonly detail: string;
}

const results: StepResult[] = [];

function recordStep(step: string, status: StepResult['status'], detail: string): void {
  results.push({ step, status, detail });
  const icon = status === 'PASS' ? '[OK]' : status === 'FAIL' ? '[FAIL]' : '[SKIP]';
  // eslint-disable-next-line no-console
  console.log(`${icon} ${step} — ${detail}`);
}

// ---------------------------------------------------------------------------
// Host-capability preflight — Docker + psql must be present.
// ---------------------------------------------------------------------------

function toolAvailable(cmd: string): boolean {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && !!r.stdout.trim();
}

function dockerDaemonRunning(): boolean {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8' });
  return r.status === 0;
}

function preflight(): { ok: boolean; reason?: string } {
  if (!toolAvailable('docker')) {
    return { ok: false, reason: 'docker CLI not found on PATH' };
  }
  if (!toolAvailable('psql')) {
    return { ok: false, reason: 'psql CLI not found on PATH (install via brew install postgresql)' };
  }
  if (!dockerDaemonRunning()) {
    return { ok: false, reason: 'docker daemon not responding (start Docker Desktop)' };
  }
  for (const sql of [F_A_02_SQL, F_B_75_SQL]) {
    if (!fs.existsSync(sql)) {
      return { ok: false, reason: `missing migration file: ${sql}` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Docker lifecycle — start, wait-for-ready, teardown.
// ---------------------------------------------------------------------------

function runDocker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function startContainer(): void {
  // Remove a prior container with the same name (defensive; name is pid-scoped).
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { encoding: 'utf8' });
  runDocker([
    'run',
    '--rm',
    '-d',
    '--name', CONTAINER_NAME,
    '-e', `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '-e', `POSTGRES_USER=${POSTGRES_USER}`,
    '-e', `POSTGRES_DB=${POSTGRES_DB}`,
    '-p', `${HOST_PORT}:5432`,
    POSTGRES_IMAGE,
  ]);
}

function stopContainer(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { encoding: 'utf8' });
}

function waitForPostgresReady(): void {
  const deadline = Date.now() + POSTGRES_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = spawnSync(
      'pg_isready',
      ['-h', HOST, '-p', String(HOST_PORT), '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-t', '2'],
      { encoding: 'utf8' },
    );
    if (r.status === 0) return;
    const sleep = spawnSync('sleep', [String(POSTGRES_STARTUP_POLL_MS / 1000)], { encoding: 'utf8' });
    if (sleep.error) break;
  }
  throw new Error('postgres did not become ready within timeout');
}

// ---------------------------------------------------------------------------
// psql helpers — all calls pinned to localhost + throwaway credentials.
// ---------------------------------------------------------------------------

function psqlEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: HOST,
    PGPORT: String(HOST_PORT),
    PGUSER: POSTGRES_USER,
    PGPASSWORD: POSTGRES_PASSWORD,
    PGDATABASE: POSTGRES_DB,
  };
}

function psql(sql: string): string {
  const r = spawnSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { env: psqlEnv(), encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`psql query failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
  }
  return r.stdout.trim();
}

function psqlFile(sqlPath: string): { stdout: string; stderr: string } {
  const r = spawnSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-f', sqlPath],
    { env: psqlEnv(), encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`psql file exec failed (${sqlPath}): ${r.stderr || r.stdout}`);
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Bootstrap a minimal schema so the migrations have something to ALTER.
//   - Only the columns the two SQL files touch are modelled; this intentionally
//     mirrors the narrow footprint of the migrations, not the full Prisma
//     schema, to keep the dry-run fast.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SCHEMA_SQL = `
-- Minimal "Order" + "User" scaffold — ONLY the columns these migrations touch.
CREATE TABLE "Order" (
  "id"            TEXT PRIMARY KEY,
  "customerId"    TEXT NOT NULL,
  "totalAmount"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "User" (
  "id"            TEXT PRIMARY KEY,
  "role"          TEXT NOT NULL,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "isVerified"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed representative rows so verification queries have signal.
INSERT INTO "Order" ("id", "customerId") VALUES
  ('order-legacy-1', 'cust-1'),
  ('order-legacy-2', 'cust-2');

INSERT INTO "User" ("id", "role", "isActive", "isVerified") VALUES
  ('u-trans-verified', 'transporter', true,  true),
  ('u-trans-pending',  'transporter', true,  false),
  ('u-driver',         'driver',      true,  true),
  ('u-customer',       'customer',    true,  false);
`;

function bootstrapSchema(): void {
  const r = spawnSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-c', BOOTSTRAP_SCHEMA_SQL],
    { env: psqlEnv(), encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`bootstrap schema failed: ${r.stderr || r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Verification assertions — mirror the verification comments in each SQL file.
// ---------------------------------------------------------------------------

interface PreSnapshot {
  readonly orderCountNullIdempotency: string;
  readonly transporterCount: string;
  readonly trustedTransporterCount: string;
}

function capturePreState(): PreSnapshot {
  return {
    orderCountNullIdempotency: psql(
      `SELECT COUNT(*) FROM "Order";`,
    ),
    transporterCount: psql(
      `SELECT COUNT(*) FROM "User" WHERE "role" = 'transporter';`,
    ),
    trustedTransporterCount: psql(
      `SELECT COUNT(*) FROM "User" WHERE "role" = 'transporter' AND "isActive" = true AND "isVerified" = true;`,
    ),
  };
}

function assertF_A_02Post(pre: PreSnapshot): void {
  // Column exists.
  const colExists = psql(
    `SELECT COUNT(*) FROM information_schema.columns
       WHERE table_name = 'Order' AND column_name = 'idempotencyKey';`,
  );
  if (colExists !== '1') {
    throw new Error(`F-A-02: idempotencyKey column missing (got ${colExists})`);
  }

  // Partial-unique index exists with expected predicate.
  const idxRow = psql(
    `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'Order' AND indexname = 'idx_order_idempotency_key';`,
  );
  if (!idxRow.includes('UNIQUE')) {
    throw new Error(`F-A-02: idx_order_idempotency_key is not UNIQUE: ${idxRow}`);
  }
  if (!idxRow.includes('idempotencyKey') || !idxRow.toLowerCase().includes('is not null')) {
    throw new Error(`F-A-02: expected partial predicate (idempotencyKey IS NOT NULL): ${idxRow}`);
  }

  // Row count preserved — migration is additive.
  const afterCount = psql(`SELECT COUNT(*) FROM "Order";`);
  if (afterCount !== pre.orderCountNullIdempotency) {
    throw new Error(
      `F-A-02: Order row count changed (pre=${pre.orderCountNullIdempotency}, post=${afterCount})`,
    );
  }
}

function assertF_B_75Post(pre: PreSnapshot): void {
  // Enum type created.
  const enumRow = psql(
    `SELECT enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'KycStatus'
       ORDER BY enumsortorder;`,
  );
  const expectedLabels = ['NOT_STARTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'];
  for (const label of expectedLabels) {
    if (!enumRow.split('\n').includes(label)) {
      throw new Error(`F-B-75: missing enum label ${label} on KycStatus (got ${enumRow})`);
    }
  }

  // Column exists and is NOT NULL with default NOT_STARTED.
  const colRow = psql(
    `SELECT is_nullable || '|' || column_default FROM information_schema.columns
       WHERE table_name = 'User' AND column_name = 'kycStatus';`,
  );
  if (!colRow.startsWith('NO|')) {
    throw new Error(`F-B-75: kycStatus should be NOT NULL, got ${colRow}`);
  }
  if (!colRow.includes('NOT_STARTED')) {
    throw new Error(`F-B-75: kycStatus default should be NOT_STARTED, got ${colRow}`);
  }

  // Index exists.
  const idxRow = psql(
    `SELECT indexname FROM pg_indexes
       WHERE tablename = 'User' AND indexname = 'idx_user_role_active_kyc';`,
  );
  if (idxRow !== 'idx_user_role_active_kyc') {
    throw new Error(`F-B-75: expected idx_user_role_active_kyc, got ${idxRow}`);
  }

  // Seed: every trusted transporter must now be VERIFIED.
  const verifiedTrusted = psql(
    `SELECT COUNT(*) FROM "User"
       WHERE "role" = 'transporter' AND "isActive" = true AND "isVerified" = true AND "kycStatus" = 'VERIFIED';`,
  );
  if (verifiedTrusted !== pre.trustedTransporterCount) {
    throw new Error(
      `F-B-75: trusted transporter VERIFIED count mismatch (pre=${pre.trustedTransporterCount}, post=${verifiedTrusted})`,
    );
  }

  // Non-trusted rows MUST remain NOT_STARTED.
  const notStarted = psql(
    `SELECT COUNT(*) FROM "User"
       WHERE NOT ("role" = 'transporter' AND "isActive" = true AND "isVerified" = true)
         AND "kycStatus" = 'NOT_STARTED';`,
  );
  const totalUsers = psql(`SELECT COUNT(*) FROM "User";`);
  const expectedNotStarted = Number(totalUsers) - Number(pre.trustedTransporterCount);
  if (Number(notStarted) !== expectedNotStarted) {
    throw new Error(
      `F-B-75: expected ${expectedNotStarted} NOT_STARTED rows, found ${notStarted}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotency check — apply each migration a second time and assert the
// verification assertions still hold AND no rows were mutated.
// ---------------------------------------------------------------------------

function assertSecondRunIsNoOp(sqlPath: string, pre: PreSnapshot): void {
  const beforeVerifiedTrusted = psql(
    `SELECT COUNT(*) FROM "User" WHERE "kycStatus" = 'VERIFIED';`,
  );
  const beforeOrderCount = psql(`SELECT COUNT(*) FROM "Order";`);

  psqlFile(sqlPath);

  const afterVerifiedTrusted = psql(
    `SELECT COUNT(*) FROM "User" WHERE "kycStatus" = 'VERIFIED';`,
  );
  const afterOrderCount = psql(`SELECT COUNT(*) FROM "Order";`);

  if (beforeVerifiedTrusted !== afterVerifiedTrusted) {
    throw new Error(
      `idempotency violation (${path.basename(sqlPath)}): VERIFIED count drifted ${beforeVerifiedTrusted} -> ${afterVerifiedTrusted}`,
    );
  }
  if (beforeOrderCount !== afterOrderCount) {
    throw new Error(
      `idempotency violation (${path.basename(sqlPath)}): Order count drifted ${beforeOrderCount} -> ${afterOrderCount}`,
    );
  }

  // Re-run assertions — schema must still be valid.
  if (sqlPath === F_A_02_SQL) assertF_A_02Post(pre);
  if (sqlPath === F_B_75_SQL) assertF_B_75Post(pre);
}

// ---------------------------------------------------------------------------
// Entry-point — orchestrate the dry-run, always tear down container.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('=== Phase 3 SQL Migration Dry-Run (W0-2) ===\n');

  const pre = preflight();
  if (!pre.ok) {
    recordStep('preflight', 'FAIL', pre.reason || 'unknown');
    // eslint-disable-next-line no-console
    console.error(
      '\nOperator action: ensure Docker Desktop + psql are installed and the daemon is running.\n' +
      'This script intentionally never connects to prod — if you cannot run Docker locally,\n' +
      'live validation is deferred and the SQL idempotency must be asserted by reading the\n' +
      'CREATE ... IF NOT EXISTS / DO $$ BEGIN ... EXCEPTION guards inside each migration file.',
    );
    process.exit(2);
  }
  recordStep('preflight', 'PASS', 'docker + psql available, daemon running');

  try {
    startContainer();
    recordStep('container-start', 'PASS', `${CONTAINER_NAME} on ${HOST}:${HOST_PORT}`);

    waitForPostgresReady();
    recordStep('postgres-ready', 'PASS', `accepted connections at ${HOST}:${HOST_PORT}`);

    bootstrapSchema();
    recordStep('bootstrap-schema', 'PASS', 'Order + User scaffolded with seed rows');

    const snapshot = capturePreState();
    recordStep(
      'pre-state',
      'PASS',
      `orders=${snapshot.orderCountNullIdempotency}, transporters=${snapshot.transporterCount}, trusted=${snapshot.trustedTransporterCount}`,
    );

    // --- F-A-02 first run ---
    psqlFile(F_A_02_SQL);
    assertF_A_02Post(snapshot);
    recordStep('F-A-02 first-run', 'PASS', 'idempotencyKey column + partial-unique index applied');

    // --- F-B-75 first run ---
    psqlFile(F_B_75_SQL);
    assertF_B_75Post(snapshot);
    recordStep('F-B-75 first-run', 'PASS', 'KycStatus enum + column + index + seed applied');

    // --- Idempotency: run both again, expect no-op ---
    assertSecondRunIsNoOp(F_A_02_SQL, snapshot);
    recordStep('F-A-02 second-run (idempotent)', 'PASS', 'no row drift, schema stable');

    assertSecondRunIsNoOp(F_B_75_SQL, snapshot);
    recordStep('F-B-75 second-run (idempotent)', 'PASS', 'no row drift, schema stable');

    // --- Final summary ---
    // eslint-disable-next-line no-console
    console.log('\n=== Summary ===');
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.status.padEnd(4)} ${r.step}`);
    }
    // eslint-disable-next-line no-console
    console.log('\nAll migrations applied cleanly AND re-running them was a no-op.');
    // eslint-disable-next-line no-console
    console.log('This is NOT authorization to run against prod — see docs/runbooks/phase3-sql-migrations.md.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordStep('dry-run', 'FAIL', msg);
    process.exitCode = 1;
  } finally {
    try {
      stopContainer();
      recordStep('teardown', 'PASS', `${CONTAINER_NAME} removed`);
    } catch (tearErr: unknown) {
      const msg = tearErr instanceof Error ? tearErr.message : String(tearErr);
      recordStep('teardown', 'FAIL', msg);
      process.exitCode = process.exitCode || 1;
    }
  }
}

if (require.main === module) {
  // Ensure we never leak a container if the process is killed.
  const cleanup = (): void => {
    try { execSync(`docker rm -f ${CONTAINER_NAME} >/dev/null 2>&1`); } catch {
      // Best-effort cleanup — container may already be gone.
    }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`fatal: ${msg}`);
    cleanup();
    process.exit(1);
  });
}
