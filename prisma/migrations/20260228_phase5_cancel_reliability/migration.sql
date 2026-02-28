-- Phase 5 mid-flow cancellation reliability core

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "loadingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "unloadingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lifecycleEventVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "OrderLifecycleOutbox" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 10,
  "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "dlqReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "OrderCancelIdempotency" (
  "id" TEXT PRIMARY KEY,
  "customerId" TEXT NOT NULL,
  "operation" TEXT NOT NULL DEFAULT 'cancel',
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "CancellationLedger" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "driverId" TEXT,
  "policyStage" TEXT NOT NULL,
  "reasonCode" TEXT,
  "penaltyAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "compensationAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "settlementState" TEXT NOT NULL DEFAULT 'pending',
  "cancelDecision" TEXT NOT NULL DEFAULT 'allowed',
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "CustomerPenaltyDue" (
  "id" TEXT PRIMARY KEY,
  "customerId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'due',
  "nextOrderHint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "DriverCompensationLedger" (
  "id" TEXT PRIMARY KEY,
  "driverId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "CancellationAbuseCounter" (
  "customerId" TEXT PRIMARY KEY,
  "cancelCount7d" INTEGER NOT NULL DEFAULT 0,
  "cancelCount30d" INTEGER NOT NULL DEFAULT 0,
  "cancelAfterLoadingCount" INTEGER NOT NULL DEFAULT 0,
  "cancelRebook2mCount" INTEGER NOT NULL DEFAULT 0,
  "cooldownUntil" TIMESTAMP(3),
  "riskTier" TEXT NOT NULL DEFAULT 'normal',
  "lastCancelAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "CancelDispute" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "reasonCode" TEXT,
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderCancelIdempotency_customerId_operation_idempotencyKey_key"
  ON "OrderCancelIdempotency" ("customerId", "operation", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "OrderLifecycleOutbox_orderId_eventType_status_idx"
  ON "OrderLifecycleOutbox" ("orderId", "eventType", "status");

CREATE INDEX IF NOT EXISTS "OrderLifecycleOutbox_status_nextRetryAt_createdAt_idx"
  ON "OrderLifecycleOutbox" ("status", "nextRetryAt", "createdAt");

CREATE INDEX IF NOT EXISTS "OrderCancelIdempotency_customerId_createdAt_idx"
  ON "OrderCancelIdempotency" ("customerId", "createdAt");

CREATE INDEX IF NOT EXISTS "OrderCancelIdempotency_orderId_createdAt_idx"
  ON "OrderCancelIdempotency" ("orderId", "createdAt");

CREATE INDEX IF NOT EXISTS "CancellationLedger_orderId_createdAt_idx"
  ON "CancellationLedger" ("orderId", "createdAt");

CREATE INDEX IF NOT EXISTS "CancellationLedger_customerId_settlementState_createdAt_idx"
  ON "CancellationLedger" ("customerId", "settlementState", "createdAt");

CREATE INDEX IF NOT EXISTS "CustomerPenaltyDue_customerId_state_createdAt_idx"
  ON "CustomerPenaltyDue" ("customerId", "state", "createdAt");

CREATE INDEX IF NOT EXISTS "CustomerPenaltyDue_orderId_state_idx"
  ON "CustomerPenaltyDue" ("orderId", "state");

CREATE INDEX IF NOT EXISTS "DriverCompensationLedger_driverId_state_createdAt_idx"
  ON "DriverCompensationLedger" ("driverId", "state", "createdAt");

CREATE INDEX IF NOT EXISTS "DriverCompensationLedger_orderId_state_idx"
  ON "DriverCompensationLedger" ("orderId", "state");

CREATE INDEX IF NOT EXISTS "CancellationAbuseCounter_customerId_updatedAt_idx"
  ON "CancellationAbuseCounter" ("customerId", "updatedAt");

CREATE INDEX IF NOT EXISTS "CancelDispute_orderId_createdAt_idx"
  ON "CancelDispute" ("orderId", "createdAt");

CREATE INDEX IF NOT EXISTS "CancelDispute_customerId_status_createdAt_idx"
  ON "CancelDispute" ("customerId", "status", "createdAt");
