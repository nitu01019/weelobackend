-- Add new enum values for broadcast lifecycle states
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'created' BEFORE 'active';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'broadcasting' BEFORE 'active';

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'created' BEFORE 'active';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'broadcasting' BEFORE 'active';

-- Add stateChangedAt timestamp field to Booking and Order
-- Backfill from createdAt so existing rows reflect their actual creation time,
-- not the migration timestamp. Future rows will always have stateChangedAt set
-- explicitly by the application on every status transition.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "stateChangedAt" TIMESTAMP(3);
UPDATE "Booking" SET "stateChangedAt" = "createdAt" WHERE "stateChangedAt" IS NULL;
ALTER TABLE "Booking" ALTER COLUMN "stateChangedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "stateChangedAt" TIMESTAMP(3);
UPDATE "Order" SET "stateChangedAt" = "createdAt" WHERE "stateChangedAt" IS NULL;
ALTER TABLE "Order" ALTER COLUMN "stateChangedAt" SET DEFAULT CURRENT_TIMESTAMP;
