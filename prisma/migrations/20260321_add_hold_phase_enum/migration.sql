-- Create HoldPhase enum type for two-phase truck hold system (PRD 7777)
-- This enum is used by Prisma to enforce phase values

CREATE TYPE "HoldPhase" AS ENUM ('FLEX', 'CONFIRMED', 'EXPIRED', 'RELEASED');
