-- Add new enum values for broadcast lifecycle states
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'created' BEFORE 'active';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'broadcasting' BEFORE 'active';

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'created' BEFORE 'active';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'broadcasting' BEFORE 'active';

-- Add stateChangedAt timestamp field to Booking and Order
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "stateChangedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "stateChangedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
