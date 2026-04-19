-- =============================================================================
-- Phase 6 Indexes — M-9 + L-1
-- Run manually on production via psql (DO NOT use prisma migrate deploy)
-- =============================================================================

-- M-9: Composite index for active order lookups by customer
-- Accelerates getActiveOrderByCustomer() which queries:
--   WHERE customerId = ? AND status NOT IN (...) AND expiresAt > now()
-- CONCURRENTLY avoids table lock in production.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_customerId_status_expiresAt_idx"
  ON "Order" ("customerId", "status", "expiresAt");

-- L-1: Composite index for expiry sweep queries
-- Accelerates cleanup-expired-orders.job which queries:
--   WHERE status IN ('active','partially_filled',...) AND expiresAt <= now()
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_status_expiresAt_idx"
  ON "Order" ("status", "expiresAt");
