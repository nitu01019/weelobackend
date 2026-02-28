-- Phase 4 hold/accept reliability core

CREATE TABLE IF NOT EXISTS "TruckHoldLedger" (
  "holdId" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "transporterId" TEXT NOT NULL,
  "vehicleType" TEXT NOT NULL,
  "vehicleSubtype" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "truckRequestIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "terminalReason" TEXT,
  "releasedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "TruckHoldIdempotency" (
  "id" TEXT PRIMARY KEY,
  "transporterId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "TruckHoldIdempotency_transporterId_operation_idempotencyKey_key"
  ON "TruckHoldIdempotency" ("transporterId", "operation", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "TruckHoldLedger_orderId_status_expiresAt_idx"
  ON "TruckHoldLedger" ("orderId", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "TruckHoldLedger_transporterId_status_expiresAt_idx"
  ON "TruckHoldLedger" ("transporterId", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "TruckHoldIdempotency_transporterId_operation_createdAt_idx"
  ON "TruckHoldIdempotency" ("transporterId", "operation", "createdAt");

CREATE INDEX IF NOT EXISTS "TruckRequest_orderId_vehicleType_vehicleSubtype_status_requestNumber_idx"
  ON "TruckRequest" ("orderId", "vehicleType", "vehicleSubtype", "status", "requestNumber");

CREATE INDEX IF NOT EXISTS "TruckRequest_status_heldAt_idx"
  ON "TruckRequest" ("status", "heldAt");
