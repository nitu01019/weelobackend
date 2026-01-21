-- =============================================================================
-- WEELO DATABASE INITIALIZATION SCRIPT
-- =============================================================================
--
-- This script creates the initial database schema for Weelo Backend.
-- It's designed for PostgreSQL and will be used by:
-- - Docker Compose (local development)
-- - AWS RDS (production)
--
-- RUN:
--   psql -U weelo -d weelo -f init-db.sql
--
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";      -- For UUID generation
CREATE EXTENSION IF NOT EXISTS "pg_trgm";        -- For text search
CREATE EXTENSION IF NOT EXISTS "postgis";        -- For geospatial queries (optional)

-- =============================================================================
-- USERS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'transporter', 'driver')),
    name VARCHAR(255),
    email VARCHAR(255),
    profile_photo TEXT,
    company VARCHAR(255),
    gst_number VARCHAR(20),
    business_name VARCHAR(255),
    business_address TEXT,
    pan_number VARCHAR(20),
    transporter_id UUID REFERENCES users(id),
    license_number VARCHAR(50),
    license_expiry DATE,
    aadhar_number VARCHAR(20),
    is_verified BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    is_available BOOLEAN DEFAULT true,
    fcm_token TEXT,
    last_active_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    -- Unique constraint on phone + role combination
    CONSTRAINT unique_phone_role UNIQUE (phone, role)
);

-- Indexes for users
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_transporter_id ON users(transporter_id);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_users_is_available ON users(is_available) WHERE is_available = true;

-- =============================================================================
-- VEHICLES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS vehicles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transporter_id UUID NOT NULL REFERENCES users(id),
    assigned_driver_id UUID REFERENCES users(id),
    vehicle_number VARCHAR(20) NOT NULL,
    vehicle_type VARCHAR(50) NOT NULL,
    vehicle_subtype VARCHAR(50),
    capacity VARCHAR(50),
    model VARCHAR(100),
    year INTEGER,
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'in_transit', 'maintenance', 'inactive')),
    current_trip_id UUID,
    maintenance_reason TEXT,
    maintenance_end_date DATE,
    last_status_change TIMESTAMP WITH TIME ZONE,
    rc_number VARCHAR(50),
    rc_expiry DATE,
    insurance_number VARCHAR(50),
    insurance_expiry DATE,
    permit_number VARCHAR(50),
    permit_expiry DATE,
    fitness_expiry DATE,
    photos TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT unique_vehicle_number UNIQUE (vehicle_number)
);

-- Indexes for vehicles
CREATE INDEX IF NOT EXISTS idx_vehicles_transporter ON vehicles(transporter_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_driver ON vehicles(assigned_driver_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
CREATE INDEX IF NOT EXISTS idx_vehicles_type ON vehicles(vehicle_type, vehicle_subtype);
CREATE INDEX IF NOT EXISTS idx_vehicles_available ON vehicles(transporter_id, status) WHERE status = 'available';

-- =============================================================================
-- BOOKINGS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES users(id),
    transporter_id UUID REFERENCES users(id),
    driver_id UUID REFERENCES users(id),
    vehicle_id UUID REFERENCES vehicles(id),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'assigned', 'in_transit', 'completed', 'cancelled')),
    
    -- Pickup location
    pickup_address TEXT NOT NULL,
    pickup_latitude DECIMAL(10, 8),
    pickup_longitude DECIMAL(11, 8),
    pickup_city VARCHAR(100),
    pickup_state VARCHAR(100),
    pickup_pincode VARCHAR(10),
    pickup_landmark TEXT,
    
    -- Dropoff location
    dropoff_address TEXT NOT NULL,
    dropoff_latitude DECIMAL(10, 8),
    dropoff_longitude DECIMAL(11, 8),
    dropoff_city VARCHAR(100),
    dropoff_state VARCHAR(100),
    dropoff_pincode VARCHAR(10),
    dropoff_landmark TEXT,
    
    vehicle_type VARCHAR(50) NOT NULL,
    vehicle_subtype VARCHAR(50),
    scheduled_at TIMESTAMP WITH TIME ZONE,
    fare DECIMAL(10, 2),
    distance DECIMAL(10, 2),
    duration INTEGER, -- in minutes
    notes TEXT,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    review TEXT,
    completed_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    cancellation_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for bookings
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_transporter ON bookings(transporter_id);
CREATE INDEX IF NOT EXISTS idx_bookings_driver ON bookings(driver_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_active ON bookings(status) WHERE status NOT IN ('completed', 'cancelled');

-- =============================================================================
-- ORDERS TABLE (Multi-vehicle orders)
-- =============================================================================
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'partial', 'confirmed', 'in_progress', 'completed', 'cancelled')),
    
    -- Pickup location
    pickup_address TEXT NOT NULL,
    pickup_latitude DECIMAL(10, 8),
    pickup_longitude DECIMAL(11, 8),
    
    -- Dropoff location  
    dropoff_address TEXT NOT NULL,
    dropoff_latitude DECIMAL(10, 8),
    dropoff_longitude DECIMAL(11, 8),
    
    total_trucks INTEGER NOT NULL,
    confirmed_trucks INTEGER DEFAULT 0,
    total_fare DECIMAL(12, 2),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for orders
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- =============================================================================
-- TRUCK REQUESTS TABLE (Part of multi-vehicle orders)
-- =============================================================================
CREATE TABLE IF NOT EXISTS truck_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    vehicle_type VARCHAR(50) NOT NULL,
    vehicle_subtype VARCHAR(50),
    quantity INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'broadcasting', 'partial', 'fulfilled', 'cancelled')),
    assigned_count INTEGER DEFAULT 0,
    fare DECIMAL(10, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for truck requests
CREATE INDEX IF NOT EXISTS idx_truck_requests_order ON truck_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_truck_requests_status ON truck_requests(status);

-- =============================================================================
-- ASSIGNMENTS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID REFERENCES bookings(id),
    order_id UUID REFERENCES orders(id),
    truck_request_id UUID REFERENCES truck_requests(id),
    transporter_id UUID NOT NULL REFERENCES users(id),
    driver_id UUID NOT NULL REFERENCES users(id),
    vehicle_id UUID NOT NULL REFERENCES vehicles(id),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'in_transit', 'completed', 'cancelled')),
    accepted_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for assignments
CREATE INDEX IF NOT EXISTS idx_assignments_booking ON assignments(booking_id);
CREATE INDEX IF NOT EXISTS idx_assignments_order ON assignments(order_id);
CREATE INDEX IF NOT EXISTS idx_assignments_transporter ON assignments(transporter_id);
CREATE INDEX IF NOT EXISTS idx_assignments_driver ON assignments(driver_id);
CREATE INDEX IF NOT EXISTS idx_assignments_vehicle ON assignments(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);

-- =============================================================================
-- TRACKING TABLE (GPS locations)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    driver_id UUID NOT NULL REFERENCES users(id),
    vehicle_id UUID NOT NULL REFERENCES vehicles(id),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    accuracy DECIMAL(6, 2),
    heading DECIMAL(5, 2),
    speed DECIMAL(6, 2),
    battery_level INTEGER,
    is_moving BOOLEAN DEFAULT true,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for tracking (time-series optimized)
CREATE INDEX IF NOT EXISTS idx_tracking_booking ON tracking(booking_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_driver ON tracking(driver_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_time ON tracking(recorded_at DESC);

-- Partition tracking table by month for better performance (optional but recommended for high volume)
-- CREATE TABLE tracking_y2024m01 PARTITION OF tracking FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- =============================================================================
-- OTP TABLE (Temporary, auto-cleanup)
-- =============================================================================
CREATE TABLE IF NOT EXISTS otps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) NOT NULL,
    role VARCHAR(20) NOT NULL,
    otp VARCHAR(10) NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for OTP lookup
CREATE INDEX IF NOT EXISTS idx_otps_phone_role ON otps(phone, role);
CREATE INDEX IF NOT EXISTS idx_otps_expires ON otps(expires_at);

-- =============================================================================
-- REFRESH TOKENS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    device_info TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for refresh tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- =============================================================================
-- NOTIFICATIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT,
    data JSONB,
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id) WHERE is_read = false;

-- =============================================================================
-- AUDIT LOG TABLE (For tracking important changes)
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for audit logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at trigger to all tables
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_vehicles_updated_at BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_truck_requests_updated_at BEFORE UPDATE ON truck_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_assignments_updated_at BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to clean up expired OTPs (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_otps()
RETURNS void AS $$
BEGIN
    DELETE FROM otps WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to clean up old tracking data (keep last 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_tracking()
RETURNS void AS $$
BEGIN
    DELETE FROM tracking WHERE recorded_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- INITIAL DATA (Optional - for development)
-- =============================================================================

-- You can uncomment these to seed initial data
-- INSERT INTO users (phone, role, name, is_verified, is_active) 
-- VALUES ('9999999999', 'transporter', 'Test Transporter', true, true);

-- =============================================================================
-- GRANTS (for application user)
-- =============================================================================

-- If using a separate app user (recommended for security)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO weelo_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO weelo_app;

-- =============================================================================
-- DONE
-- =============================================================================
