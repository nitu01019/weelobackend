-- Create HoldPhase enum type for two-phase truck hold system (PRD 7777)
-- This enum is used by Prisma to enforce phase values

-- PostgreSQL requires function DO block for CREATE TYPE IF NOT EXISTS
DO $$ BEGIN
    CREATE TYPE "HoldPhase" AS ENUM ('FLEX', 'CONFIRMED', 'EXPIRED', 'RELEASED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
