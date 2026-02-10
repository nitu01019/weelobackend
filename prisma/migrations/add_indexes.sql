-- Performance Optimization: Database Indexes
-- These indexes dramatically improve query performance for millions of users

-- Users table indexes
CREATE INDEX IF NOT EXISTS idx_users_phone ON "User"(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON "User"(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON "User"(role);
CREATE INDEX IF NOT EXISTS idx_users_preferred_language ON "User"("preferredLanguage");
CREATE INDEX IF NOT EXISTS idx_users_role_online ON "User"(role, "isOnline") WHERE role = 'driver';
CREATE INDEX IF NOT EXISTS idx_users_role_created ON "User"(role, "createdAt" DESC);

-- Vehicles table indexes
CREATE INDEX IF NOT EXISTS idx_vehicles_owner ON "Vehicle"("ownerId");
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON "Vehicle"(status);
CREATE INDEX IF NOT EXISTS idx_vehicles_type ON "Vehicle"(type);

-- Analyze tables
ANALYZE "User";
ANALYZE "Vehicle";
