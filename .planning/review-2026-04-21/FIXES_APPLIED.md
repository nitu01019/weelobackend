# Fixes Applied — Critical (2026-04-21 review)

| Date | Finding | Verdict | Wave | Commit | Owner | Outcome |
|------|---------|---------|------|--------|-------|---------|
| 2026-04-22 | A10-009 | TRUE | W1 | n/a | db-migration-owner | M-015 + M-016 files audited on branch (2040 B / 1974 B; headers FILE-ONLY; idempotent IF NOT EXISTS + DO $$ EXCEPTION); prod psql-apply deferred to ops handoff (DATABASE_URL VPN-gated, unavailable in session) |
| 2026-04-22 | A10-001 | TRUE | W1 | 2b1ee4f8 | db-migration-owner | M-017 SQL file added (CREATE INDEX CONCURRENTLY IF NOT EXISTS truck_hold_ledger_active_find_idx ON TruckHoldLedger(transporterId, orderId, phase) partial); prod psql-apply deferred to ops handoff |
| 2026-04-22 | A10-001 | TRUE | W1 | 14961bcc | ilike-tightening-owner | mode:'insensitive' dropped from findActiveLedgerHold in 2 files (truck-hold-create.service.ts + truck-hold.service.ts); pre-flight data-sanity + EXPLAIN ANALYZE deferred to ops (DATABASE_URL VPN-gated); normalizeVehiclePart write-side lowercasing confirms correctness |
