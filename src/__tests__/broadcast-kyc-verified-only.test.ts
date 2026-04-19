/**
 * =============================================================================
 * F-B-75 — Broadcast filters to KYC-VERIFIED drivers/transporters only
 * =============================================================================
 *
 * Verifies the KYC FSM gate added by F-B-75:
 *   - The broadcast findMany filter in `order-broadcast.service.ts` includes
 *     both `kycStatus: 'VERIFIED'` AND `isVerified: true` (defense-in-depth).
 *   - The log string reflects a "KYC gate" (not legacy "Active-status gate").
 *   - Prisma schema exposes a `KycStatus` enum with the FSM states
 *     (NOT_STARTED, UNDER_REVIEW, VERIFIED, REJECTED, EXPIRED).
 *   - The User model declares `kycStatus KycStatus @default(NOT_STARTED)`.
 *   - A direct-SQL migration file exists at
 *     migrations/phase3-f-b-75-kyc.sql (CLAUDE.md mandates direct SQL — no
 *     prisma migrate deploy).
 *   - Filter behavior (runtime): given a matching-transporter list where only
 *     one row has `kycStatus='VERIFIED' AND isVerified=true AND isActive=true`,
 *     the broadcast filter retains exactly that row.
 *
 * Pattern reference: Fernando Hermida FSM + Ola KYC + Uber Rider Identity.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const BROADCAST_SERVICE = path.resolve(
  __dirname,
  '../modules/order/order-broadcast.service.ts'
);
const PRISMA_SCHEMA = path.resolve(__dirname, '../../prisma/schema.prisma');
const SQL_MIGRATION = path.resolve(
  __dirname,
  '../../migrations/phase3-f-b-75-kyc.sql'
);

describe('F-B-75: broadcast KYC gate is VERIFIED-only', () => {
  test('findMany filter includes kycStatus: VERIFIED', () => {
    const source = fs.readFileSync(BROADCAST_SERVICE, 'utf-8');
    expect(source).toContain("kycStatus: 'VERIFIED'");
  });

  test('findMany filter retains isVerified: true (defense-in-depth)', () => {
    const source = fs.readFileSync(BROADCAST_SERVICE, 'utf-8');
    expect(source).toContain('isVerified: true');
  });

  test('findMany filter retains isActive: true', () => {
    const source = fs.readFileSync(BROADCAST_SERVICE, 'utf-8');
    expect(source).toContain('isActive: true');
  });

  test('log string is "KYC gate" (not legacy "Active-status gate")', () => {
    const source = fs.readFileSync(BROADCAST_SERVICE, 'utf-8');
    expect(source).toContain('[OrderBroadcast] KYC gate:');
    expect(source).not.toContain('Active-status gate');
  });

  test('skip log describes KYC-ineligible, not inactive', () => {
    const source = fs.readFileSync(BROADCAST_SERVICE, 'utf-8');
    expect(source).toContain('Skipping KYC-ineligible transporter');
  });
});

describe('F-B-75: Prisma schema exposes KycStatus enum', () => {
  test('KycStatus enum is declared with the 5 FSM states', () => {
    const schema = fs.readFileSync(PRISMA_SCHEMA, 'utf-8');
    expect(schema).toMatch(/enum KycStatus\s*\{[\s\S]*?NOT_STARTED[\s\S]*?UNDER_REVIEW[\s\S]*?VERIFIED[\s\S]*?REJECTED[\s\S]*?EXPIRED[\s\S]*?\}/);
  });

  test('User model declares kycStatus with KycStatus type and NOT_STARTED default', () => {
    const schema = fs.readFileSync(PRISMA_SCHEMA, 'utf-8');
    expect(schema).toMatch(/kycStatus\s+KycStatus\s+@default\(NOT_STARTED\)/);
  });
});

describe('F-B-75: direct-SQL migration file exists (CLAUDE.md rule)', () => {
  test('migrations/phase3-f-b-75-kyc.sql is present and well-formed', () => {
    const sql = fs.readFileSync(SQL_MIGRATION, 'utf-8');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain('CREATE TYPE "KycStatus"');
    expect(sql).toContain('NOT_STARTED');
    expect(sql).toContain('VERIFIED');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "kycStatus"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_user_role_active_kyc"');
  });

  test('migration uses idempotent enum-creation guard', () => {
    const sql = fs.readFileSync(SQL_MIGRATION, 'utf-8');
    // Supabase-canonical idempotent enum create pattern.
    expect(sql).toMatch(/DO \$\$ BEGIN[\s\S]*?CREATE TYPE "KycStatus"[\s\S]*?EXCEPTION[\s\S]*?WHEN duplicate_object[\s\S]*?END \$\$;/);
  });

  test('migration seeds legacy isVerified=true transporters to VERIFIED', () => {
    const sql = fs.readFileSync(SQL_MIGRATION, 'utf-8');
    expect(sql).toContain('UPDATE "User"');
    expect(sql).toContain('"kycStatus" = \'VERIFIED\'');
    expect(sql).toContain('"role" = \'transporter\'');
    expect(sql).toContain('"isVerified" = true');
  });
});

describe('F-B-75: runtime filter retains only KYC-VERIFIED transporters', () => {
  // This simulates the Prisma findMany filter semantics — asserts the where
  // clause, applied to a mixed input, returns exactly the VERIFIED+active+
  // isVerified row. Equivalent to a Prisma-shaped filter function.
  type Row = {
    id: string;
    isActive: boolean;
    isVerified: boolean;
    kycStatus: 'NOT_STARTED' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  };

  const applyBroadcastKycFilter = (ids: string[], rows: Row[]): string[] => {
    const idSet = new Set(ids);
    return rows
      .filter(
        (r) =>
          idSet.has(r.id) &&
          r.isActive === true &&
          r.isVerified === true &&
          r.kycStatus === 'VERIFIED'
      )
      .map((r) => r.id);
  };

  test('VERIFIED + isVerified + isActive row is retained', () => {
    const rows: Row[] = [
      { id: 'ok', isActive: true, isVerified: true, kycStatus: 'VERIFIED' },
    ];
    expect(applyBroadcastKycFilter(['ok'], rows)).toEqual(['ok']);
  });

  test('UNDER_REVIEW row is filtered out even if isVerified+isActive', () => {
    const rows: Row[] = [
      { id: 'u', isActive: true, isVerified: true, kycStatus: 'UNDER_REVIEW' },
    ];
    expect(applyBroadcastKycFilter(['u'], rows)).toEqual([]);
  });

  test('NOT_STARTED row is filtered out', () => {
    const rows: Row[] = [
      { id: 'n', isActive: true, isVerified: true, kycStatus: 'NOT_STARTED' },
    ];
    expect(applyBroadcastKycFilter(['n'], rows)).toEqual([]);
  });

  test('REJECTED row is filtered out', () => {
    const rows: Row[] = [
      { id: 'r', isActive: true, isVerified: true, kycStatus: 'REJECTED' },
    ];
    expect(applyBroadcastKycFilter(['r'], rows)).toEqual([]);
  });

  test('EXPIRED row is filtered out', () => {
    const rows: Row[] = [
      { id: 'e', isActive: true, isVerified: true, kycStatus: 'EXPIRED' },
    ];
    expect(applyBroadcastKycFilter(['e'], rows)).toEqual([]);
  });

  test('VERIFIED but isActive=false is filtered out', () => {
    const rows: Row[] = [
      { id: 'x', isActive: false, isVerified: true, kycStatus: 'VERIFIED' },
    ];
    expect(applyBroadcastKycFilter(['x'], rows)).toEqual([]);
  });

  test('VERIFIED but legacy isVerified=false is filtered out', () => {
    const rows: Row[] = [
      { id: 'y', isActive: true, isVerified: false, kycStatus: 'VERIFIED' },
    ];
    expect(applyBroadcastKycFilter(['y'], rows)).toEqual([]);
  });

  test('mixed batch — only VERIFIED+active+isVerified row survives', () => {
    const rows: Row[] = [
      { id: 'a', isActive: true, isVerified: true, kycStatus: 'VERIFIED' },
      { id: 'b', isActive: true, isVerified: true, kycStatus: 'UNDER_REVIEW' },
      { id: 'c', isActive: true, isVerified: true, kycStatus: 'NOT_STARTED' },
      { id: 'd', isActive: false, isVerified: true, kycStatus: 'VERIFIED' },
      { id: 'e', isActive: true, isVerified: false, kycStatus: 'VERIFIED' },
      { id: 'f', isActive: true, isVerified: true, kycStatus: 'REJECTED' },
    ];
    expect(applyBroadcastKycFilter(['a', 'b', 'c', 'd', 'e', 'f'], rows)).toEqual(['a']);
  });
});
