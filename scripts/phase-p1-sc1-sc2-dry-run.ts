#!/usr/bin/env ts-node
/**
 * =============================================================================
 * Phase-P1 | T1.4 — SC1 + SC2 index dry-run harness
 * =============================================================================
 *
 * Purpose:
 *   Apply `prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql` to a
 *   THROWAWAY local Docker Postgres 15 container and verify:
 *     1. Both CREATE INDEX CONCURRENTLY statements succeed on a clean schema.
 *     2. Re-running the file is a no-op (idempotency via IF NOT EXISTS).
 *     3. indisvalid=true on both indexes after each run.
 *     4. EXPLAIN (FORMAT JSON) for the two hot-path queries can be captured
 *        (plan shape is written to stdout; planner choice depends on row
 *        counts so the harness does not assert a specific node type).
 *
 * NON-GOALS / HARD CONSTRAINTS (see scripts/phase3-sql-dry-run.ts:19):
 *   - MUST NOT connect to prod, staging, or any remote RDS. Only 127.0.0.1
 *     on a port we open ourselves.
 *   - MUST NOT modify the SQL file, schema.prisma, or any runbook.
 *   - No subagent spawned by any wave may run `psql` against prod. Humans only.
 *
 * Usage:
 *   # 1. Start Docker Desktop.
 *   # 2. From repo root:
 *   npx ts-node scripts/phase-p1-sc1-sc2-dry-run.ts
 *
 *   # Exit codes:
 *   #   0 — migration applied cleanly; second run was a no-op; indexes valid.
 *   #   1 — migration failed or idempotency check failed.
 *   #   2 — Docker/psql unavailable (operator action needed).
 *
 * Important Postgres caveat:
 *   CREATE INDEX CONCURRENTLY cannot run inside a BEGIN/COMMIT block. The
 *   `-f` flag to psql runs each statement in its own implicit transaction,
 *   so the SQL file works AS-IS both in prod and in this harness. No
 *   transaction wrapper is emitted.
 * =============================================================================
 */

import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration — all values are local / synthetic. Nothing points at prod.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATION_SQL = path.join(
  REPO_ROOT,
  'prisma',
  'manual-migrations',
  'phase-p1-sc1-sc2-indexes.sql',
);

const CONTAINER_NAME = `weelo-p1-sc1-sc2-dryrun-${process.pid}`;
const POSTGRES_IMAGE = 'postgres:15';
const POSTGRES_PASSWORD = 'dryrun';
const POSTGRES_USER = 'postgres';
const POSTGRES_DB = 'weelo_dryrun';
const HOST_PORT = 54000 + Math.floor(Math.random() * 2000);
const HOST = '127.0.0.1';

const POSTGRES_STARTUP_TIMEOUT_MS = 30_000;
const POSTGRES_STARTUP_POLL_MS = 500;

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
// Preflight — Docker + psql + migration file.
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
  if (!toolAvailable('docker')) return { ok: false, reason: 'docker CLI not found on PATH' };
  if (!toolAvailable('psql')) return { ok: false, reason: 'psql CLI not found on PATH (brew install postgresql)' };
  if (!dockerDaemonRunning()) return { ok: false, reason: 'docker daemon not responding (start Docker Desktop)' };
  if (!fs.existsSync(MIGRATION_SQL)) return { ok: false, reason: `missing migration file: ${MIGRATION_SQL}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Docker lifecycle.
// ---------------------------------------------------------------------------

function runDocker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function startContainer(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { encoding: 'utf8' });
  runDocker([
    'run', '--rm', '-d',
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
// psql helpers — pinned to localhost.
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

function psqlFile(sqlPath: string): void {
  const r = spawnSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-f', sqlPath],
    { env: psqlEnv(), encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(`psql file exec failed (${sqlPath}): ${r.stderr || r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap — minimal User + Vehicle scaffold matching the Prisma shape
// for the columns this migration touches. Includes the KycStatus enum that
// F-B-75 adds in prod; the SC1 index cannot be created without it.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SCHEMA_SQL = `
-- KYC enum (owned by F-B-75 in prod; replicated here so the SC1 index
-- can reference the kycStatus column).
DO $$ BEGIN
  CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED','UNDER_REVIEW','VERIFIED','REJECTED','EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "VehicleStatus" AS ENUM ('available','in_transit','maintenance','inactive','on_hold');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "User" (
  "id"          TEXT PRIMARY KEY,
  "phone"       TEXT NOT NULL,
  "role"        TEXT NOT NULL,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "isVerified"  BOOLEAN NOT NULL DEFAULT false,
  "kycStatus"   "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Vehicle" (
  "id"            TEXT PRIMARY KEY,
  "transporterId" TEXT NOT NULL,
  "vehicleKey"    TEXT,
  "status"        "VehicleStatus" NOT NULL DEFAULT 'available',
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed — enough rows to exercise both indexes.
INSERT INTO "User" ("id","phone","role","isActive","isVerified","kycStatus") VALUES
  ('u-tv-1', '9000000001', 'transporter', true,  true,  'VERIFIED'),
  ('u-tv-2', '9000000002', 'transporter', true,  true,  'VERIFIED'),
  ('u-tp-1', '9000000003', 'transporter', true,  false, 'NOT_STARTED'),
  ('u-tp-2', '9000000004', 'transporter', true,  false, 'UNDER_REVIEW'),
  ('u-ti-1', '9000000005', 'transporter', false, true,  'VERIFIED'),
  ('u-dr-1', '9000000006', 'driver',      true,  true,  'NOT_STARTED'),
  ('u-cu-1', '9000000007', 'customer',    true,  false, 'NOT_STARTED')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Vehicle" ("id","transporterId","vehicleKey","status","isActive") VALUES
  ('v-open-17ft-1',   'u-tv-1', 'open_17ft',         'available',  true),
  ('v-open-17ft-2',   'u-tv-1', 'open_17ft',         'in_transit', true),
  ('v-container-1',   'u-tv-2', 'container_20ft',    'available',  true),
  ('v-tipper-1',      'u-tv-1', 'tipper_24ton',      'maintenance',true),
  ('v-inactive-1',    'u-tv-2', 'open_17ft',         'available',  false)
ON CONFLICT ("id") DO NOTHING;
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
// Verification assertions.
// ---------------------------------------------------------------------------

interface IndexRow {
  readonly name: string;
  readonly valid: boolean;
  readonly definition: string;
}

function readIndexes(): IndexRow[] {
  // Use a marker to split the three fields. `At` format strips headers.
  const raw = psql(`
    SELECT c.relname || '|' || i.indisvalid || '|' || pg_get_indexdef(i.indexrelid)
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname IN ('idx_user_kyc_broadcast','idx_vehicle_key_avail')
     ORDER BY c.relname;
  `);
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const [name, valid, ...rest] = line.split('|');
    return {
      name,
      valid: valid === 't',
      definition: rest.join('|'),
    };
  });
}

function assertIndexesPresentAndValid(): IndexRow[] {
  const rows = readIndexes();
  const names = rows.map(r => r.name);
  if (!names.includes('idx_user_kyc_broadcast')) {
    throw new Error('idx_user_kyc_broadcast missing after migration');
  }
  if (!names.includes('idx_vehicle_key_avail')) {
    throw new Error('idx_vehicle_key_avail missing after migration');
  }
  for (const r of rows) {
    if (!r.valid) {
      throw new Error(`${r.name} is indisvalid=false (concurrent build aborted)`);
    }
  }
  // Sanity-check the partial predicate is present on SC2.
  const sc2 = rows.find(r => r.name === 'idx_vehicle_key_avail');
  if (!sc2 || !/WHERE/i.test(sc2.definition)) {
    throw new Error(`idx_vehicle_key_avail lost its partial WHERE clause: ${sc2?.definition ?? '<missing>'}`);
  }
  // Sanity-check the SC1 column order.
  const sc1 = rows.find(r => r.name === 'idx_user_kyc_broadcast');
  if (!sc1 || !/"kycStatus".*"isVerified".*"isActive"/.test(sc1.definition)) {
    throw new Error(`idx_user_kyc_broadcast column order unexpected: ${sc1?.definition ?? '<missing>'}`);
  }
  return rows;
}

function captureExplainPlans(): { sc1: string; sc2: string } {
  // EXPLAIN plans at tiny row counts often choose Seq Scan — acceptable for
  // a harness; we print rather than assert so the human can eyeball the shape.
  const sc1 = psql(`
    EXPLAIN (FORMAT TEXT)
    SELECT id FROM "User"
     WHERE id = ANY (ARRAY['u-tv-1','u-tv-2','u-tp-1']::text[])
       AND "isActive"   = true
       AND "isVerified" = true
       AND "kycStatus"  = 'VERIFIED';
  `);
  const sc2 = psql(`
    EXPLAIN (FORMAT TEXT)
    SELECT "transporterId" FROM "Vehicle"
     WHERE "vehicleKey" IN ('open_17ft','container_20ft')
       AND "isActive" = true
       AND "status"   = 'available';
  `);
  return { sc1, sc2 };
}

// ---------------------------------------------------------------------------
// Entry-point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('=== Phase-P1 T1.4 SC1+SC2 index dry-run ===\n');

  const pre = preflight();
  if (!pre.ok) {
    recordStep('preflight', 'FAIL', pre.reason || 'unknown');
    // eslint-disable-next-line no-console
    console.error(
      '\nOperator action: install Docker Desktop and postgresql-client, then re-run.\n' +
      'This script intentionally never connects to prod — if Docker is unavailable,\n' +
      'the migration idempotency relies on the `CREATE INDEX CONCURRENTLY IF NOT EXISTS`\n' +
      'guards baked into prisma/manual-migrations/phase-p1-sc1-sc2-indexes.sql.\n',
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
    recordStep('bootstrap-schema', 'PASS', 'User + Vehicle + KycStatus + VehicleStatus + seed rows');

    // --- First run ---
    psqlFile(MIGRATION_SQL);
    const firstRun = assertIndexesPresentAndValid();
    recordStep(
      'first-run',
      'PASS',
      firstRun.map(r => `${r.name}(valid=${r.valid})`).join(', '),
    );

    // --- Second run — must be a no-op ---
    psqlFile(MIGRATION_SQL);
    const secondRun = assertIndexesPresentAndValid();
    if (secondRun.length !== firstRun.length) {
      throw new Error(`index count changed across runs: ${firstRun.length} -> ${secondRun.length}`);
    }
    recordStep('second-run (idempotent)', 'PASS', 'IF NOT EXISTS guards held');

    // --- Capture EXPLAIN plans for the runbook ---
    const plans = captureExplainPlans();
    recordStep('explain-sc1', 'PASS', plans.sc1.split('\n')[0] || '<no plan>');
    recordStep('explain-sc2', 'PASS', plans.sc2.split('\n')[0] || '<no plan>');
    // eslint-disable-next-line no-console
    console.log('\n--- SC1 plan ---\n' + plans.sc1);
    // eslint-disable-next-line no-console
    console.log('\n--- SC2 plan ---\n' + plans.sc2);

    // --- Summary ---
    // eslint-disable-next-line no-console
    console.log('\n=== Summary ===');
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.status.padEnd(4)} ${r.step}`);
    }
    // eslint-disable-next-line no-console
    console.log('\nMigration applied cleanly AND re-running was a no-op.');
    // eslint-disable-next-line no-console
    console.log('This is NOT authorization to run against prod — see .planning/verification/PRODUCTION-INDEX-RUNBOOK-P1.md');
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
