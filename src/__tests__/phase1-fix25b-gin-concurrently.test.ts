import * as fs from 'fs';
import * as path from 'path';

describe('Fix #25b — GIN index migration uses CONCURRENTLY', () => {
  const migPath = path.resolve(
    __dirname,
    '../../prisma/migrations/20260225_add_truckrequest_notified_transporters_gin_index/migration.sql'
  );
  const sql = fs.readFileSync(migPath, 'utf8');

  it('contains CREATE INDEX CONCURRENTLY', () => {
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS\s+"TruckRequest_notifiedTransporters_gin_idx"/);
  });
  it('has -- prisma:no-transaction directive', () => {
    expect(sql).toMatch(/--\s*prisma:no-transaction/);
  });
  it('does NOT contain non-concurrent CREATE INDEX for the GIN index (excluding comments)', () => {
    const codeLines = sql.split('\n').filter(l => !l.trim().startsWith('--') && l.trim().length > 0);
    const nonConcurrent = codeLines.filter(l => /^\s*CREATE\s+INDEX\s+(?!CONCURRENTLY)/i.test(l));
    expect(nonConcurrent).toEqual([]);
  });
  it('includes operator runbook for indisvalid recovery', () => {
    expect(sql).toMatch(/indisvalid/);
    expect(sql).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/);
  });
  it('SPLIT requirement comment is present', () => {
    expect(sql).toMatch(/SPLIT requirement/);
  });
});
