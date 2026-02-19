-- Performance Optimization: Database Indexes
-- These indexes dramatically improve query performance for millions of users
-- NOTE: Column names must match the Prisma schema exactly

-- Users table indexes
CREATE INDEX IF NOT EXISTS idx_users_phone ON "User"(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON "User"(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON "User"(role);
CREATE INDEX IF NOT EXISTS idx_users_preferred_language ON "User"("preferredLanguage");
CREATE INDEX IF NOT EXISTS idx_users_role_available ON "User"(role, "isAvailable") WHERE role = 'driver';
CREATE INDEX IF NOT EXISTS idx_users_role_created ON "User"(role, "createdAt" DESC);

-- Vehicles table indexes
CREATE INDEX IF NOT EXISTS idx_vehicles_transporter ON "Vehicle"("transporterId");
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON "Vehicle"(status);
CREATE INDEX IF NOT EXISTS idx_vehicles_type ON "Vehicle"("vehicleType");
CREATE INDEX IF NOT EXISTS idx_vehicles_type_subtype ON "Vehicle"("vehicleType", "vehicleSubtype");

-- Analyze tables
ANALYZE "User";
ANALYZE "Vehicle";
