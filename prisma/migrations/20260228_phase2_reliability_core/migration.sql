-- Phase 2 reliability core: dispatch visibility + DB idempotency + strict quantity checks

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "dispatchState" TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "dispatchReasonCode" TEXT,
  ADD COLUMN IF NOT EXISTS "onlineCandidatesCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "notifiedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastDispatchAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Order_dispatchState_createdAt_idx"
  ON "Order" ("dispatchState", "createdAt");

CREATE TABLE IF NOT EXISTS "OrderIdempotency" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderIdempotency_customerId_idempotencyKey_key"
  ON "OrderIdempotency" ("customerId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "OrderIdempotency_customerId_createdAt_idx"
  ON "OrderIdempotency" ("customerId", "createdAt");

CREATE INDEX IF NOT EXISTS "OrderIdempotency_orderId_idx"
  ON "OrderIdempotency" ("orderId");

CREATE TABLE IF NOT EXISTS "OrderDispatchOutbox" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderDispatchOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderDispatchOutbox_orderId_key"
  ON "OrderDispatchOutbox" ("orderId");

CREATE INDEX IF NOT EXISTS "OrderDispatchOutbox_status_nextRetryAt_createdAt_idx"
  ON "OrderDispatchOutbox" ("status", "nextRetryAt", "createdAt");

CREATE INDEX IF NOT EXISTS "OrderDispatchOutbox_orderId_status_idx"
  ON "OrderDispatchOutbox" ("orderId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_total_trucks_gt_zero_chk'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT order_total_trucks_gt_zero_chk
      CHECK ("totalTrucks" > 0) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'truck_request_request_number_gt_zero_chk'
  ) THEN
    ALTER TABLE "TruckRequest"
      ADD CONSTRAINT truck_request_request_number_gt_zero_chk
      CHECK ("requestNumber" > 0) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'booking_trucks_needed_gt_zero_chk'
  ) THEN
    ALTER TABLE "Booking"
      ADD CONSTRAINT booking_trucks_needed_gt_zero_chk
      CHECK ("trucksNeeded" > 0) NOT VALID;
  END IF;
END
$$;
