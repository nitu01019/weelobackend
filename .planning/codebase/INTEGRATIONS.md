# External Integrations

**Analysis Date:** 2026-02-19

## APIs & External Services

**SMS Delivery (Production OTP):**
- Twilio - SMS delivery with SMS Retriever API support
  - SDK/Client: `twilio` (npm package, dynamic import)
  - Config: `src/modules/auth/sms.service.ts` (TwilioProvider class)
  - Auth: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` env vars
  - Usage: Called when `SMS_PROVIDER=twilio` is set

- MSG91 - India-focused SMS provider
  - SDK/Client: Native HTTP calls via `fetch`
  - Config: `src/modules/auth/sms.service.ts` (MSG91Provider class)
  - Auth: `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_TEMPLATE_ID` env vars
  - Endpoint: `https://api.msg91.com/api/v5/otp`
  - Usage: Called when `SMS_PROVIDER=msg91` is set

- AWS SNS - Cost-effective SMS for India
  - SDK/Client: `@aws-sdk/client-sns` 3.975.0
  - Config: `src/modules/auth/sms.service.ts` (SNSProvider class, partial implementation)
  - Auth: IAM role on AWS ECS (credentials optional if using ECS task role)
  - Region: `AWS_REGION` env var (default: ap-south-1)
  - Usage: Called when `SMS_PROVIDER=aws-sns` is set

- Console SMS (Development only)
  - SDK/Client: None (logs to stdout)
  - Config: `src/modules/auth/sms.service.ts` (ConsoleProvider class)
  - Usage: Default when `SMS_PROVIDER=console` (development)

**Maps & Routing:**
- Google Maps - Directions, Places, Geocoding APIs
  - SDK/Client: Native HTTP calls via `fetch`
  - Implementation: `src/shared/services/google-maps.service.ts`
  - Auth: `GOOGLE_MAPS_API_KEY` env var
  - Endpoints:
    - Directions API (routes, polylines): `https://maps.googleapis.com/maps/api/directions/json`
    - Places Autocomplete API: `https://maps.googleapis.com/maps/api/place/autocomplete/json`
    - Place Details API: `https://maps.googleapis.com/maps/api/place/details/json`
    - Geocoding API (reverse geocoding): `https://maps.googleapis.com/maps/api/geocode/json`
  - Caching: Routes cached 1 hour, places 6 hours, geocoding 24 hours
  - Metrics: Built-in monitoring of API calls, cache hits, errors
  - Feature: O(1) polyline decoding for millions of route requests

- AWS Location Service (Optional - Real road routing)
  - SDK/Client: `@aws-sdk/client-location` 3.975.0
  - Implementation: `src/shared/services/aws-location.service.ts` (if enabled)
  - Auth: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
  - Config vars: `AWS_LOCATION_ROUTE_CALCULATOR`, `AWS_LOCATION_PLACE_INDEX`
  - Feature: Real-time truck-aware routing (avoids highways, toll roads)
  - Status: Optional, disabled by default (`AWS_LOCATION_ENABLED=false`)

## Data Storage

**Databases:**
- PostgreSQL 15+ (RDS in production, local in development)
  - Connection: `DATABASE_URL` env var
  - Client: Prisma ORM (`@prisma/client` 5.22.0)
  - Features:
    - 13 models (User, Vehicle, Booking, Order, TruckRequest, Assignment, Tracking, Wallet, CustomerSettings, CustomBookingRequest, Rating, etc.)
    - Composite indexes for scalability to millions of users
    - Role-based user separation (customer, transporter, driver)
    - JSONB fields for flexible route/location storage

**File Storage:**
- AWS S3 - Document and photo uploads (driver licenses, vehicle photos)
  - SDK/Client: `@aws-sdk/client-s3` 3.978.0, `@aws-sdk/s3-request-presigner` 3.978.0
  - Implementation: `src/shared/services/s3-upload.service.ts`
  - Auth: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
  - Bucket: `S3_BUCKET` env var (default: 'weelo-uploads')
  - Region: `AWS_REGION` env var (default: 'ap-south-1')
  - Features:
    - Pre-signed URLs with 7-day expiry (Instagram-style stable URLs)
    - Direct client upload capability (bypass backend)
    - Fallback to local filesystem if S3 credentials unavailable
    - Batch photo uploads for efficiency

- Local Filesystem (Development fallback)
  - Directory: `./uploads/` with subdirectories per upload type
  - Used when S3 is not configured (development mode)

**Caching:**
- Redis 7.x
  - Primary: `REDIS_URL` env var (connection string)
  - Alternative: `REDIS_HOST`, `REDIS_PORT` for AWS ElastiCache
  - Fallback: In-memory storage if Redis unavailable (development)
  - Features:
    - Geospatial queries for driver location indexing
    - Distributed locks for truck holds (15-second timer)
    - Pub/Sub for multi-server event broadcasting
    - Rate limiting sliding window
    - Session/refresh token storage with auto-expiry
    - FCM token management (90-day TTL)
  - Config: `src/shared/services/redis.service.ts`
  - Advanced settings:
    - `REDIS_MAX_RETRIES`: Retry attempts (default: 10)
    - `REDIS_RETRY_DELAY_MS`: Delay between retries (default: 1000ms)
    - `REDIS_MAX_CONNECTIONS`: Connection pool size (default: 50)
    - `REDIS_CONNECTION_TIMEOUT_MS`: Timeout (default: 10000ms)
    - `REDIS_COMMAND_TIMEOUT_MS`: Command timeout (default: 5000ms)

## Authentication & Identity

**Auth Provider:**
- Custom JWT implementation
  - Implementation: `src/modules/auth/` (controllers, services, middleware)
  - Method: JWT access + refresh token pattern
  - Token generation: `jsonwebtoken` 9.0.2
  - Hash algorithm: HS256 (symmetric)
  - Secrets: `JWT_SECRET`, `JWT_REFRESH_SECRET` (auto-generated in dev, required in production)
  - Access token TTL: `JWT_EXPIRES_IN` (default: 7d)
  - Refresh token TTL: `JWT_REFRESH_EXPIRES_IN` (default: 30d)

- Phone-based authentication (No OAuth)
  - OTP verification via SMS
  - Phone + role creates unique user identifier
  - No third-party OAuth providers (Weelo-specific auth)

- Password hashing: bcryptjs 2.4.3 (10 salt rounds)

**Push Notifications:**
- Firebase Cloud Messaging (FCM)
  - SDK/Client: `firebase-admin` 13.6.0 (optional, dynamic import)
  - Implementation: `src/shared/services/fcm.service.ts`
  - Config: `FIREBASE_SERVICE_ACCOUNT_PATH` env var (path to JSON service account key)
  - Features:
    - Per-user token management (Redis-backed with in-memory fallback)
    - Topic-based broadcasting (e.g., `transporter_open_17ft`)
    - Multicast for multiple devices
    - Mock/logging mode if Firebase not configured (development)
    - 90-day FCM token TTL in Redis
  - Notification types: `new_broadcast`, `assignment_update`, `trip_update`, `payment`, `general`
  - Android/iOS specific payloads (notification channels, badge, sound)

## Monitoring & Observability

**Error Tracking:**
- None detected in production configuration
- Development: Console logging via Winston

**Logs:**
- Winston 3.11.0
  - Implementation: `src/shared/services/logger.service.ts`
  - Levels: debug, info, warn, error
  - Output: Console (development) and/or file (production)
  - Config: `LOG_LEVEL` env var (default: debug in dev, info in production)
  - Structure: Structured JSON logging with contextual data
  - Features: Metadata attachment, error stack traces

**Performance Metrics:**
- Google Maps API metrics: 5-minute interval logging of API calls, cache hits, errors, response times
- Built-in monitoring in: `src/shared/services/google-maps.service.ts`

## CI/CD & Deployment

**Hosting:**
- AWS ECS (Elastic Container Service)
  - Cluster: Task-based deployment
  - Container: Node 20 Alpine
  - Database: AWS RDS PostgreSQL
  - Cache: AWS ElastiCache Redis
  - Storage: AWS S3
  - Networking: VPC with security groups

**CI Pipeline:**
- GitHub Actions (configuration file: `.github/workflows/` or similar)
- Build: Docker multi-stage build
- Test: Jest (npm test)
- Deploy: ECS task update

**Container Registry:**
- Amazon ECR (Elastic Container Registry) or Docker Hub

**Process Management (Production):**
- PM2 (ecosystem.config.js) - Cluster mode for multi-core utilization
- Alternative: Docker/ECS native process management

## Environment Configuration

**Required env vars for production:**
- `NODE_ENV=production`
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - 64+ byte hex random string
- `JWT_REFRESH_SECRET` - Different 64+ byte hex random string
- `REDIS_URL` - Redis connection string (recommended for scalability)
- `REDIS_HOST`, `REDIS_PORT` - Alternative to REDIS_URL (AWS ElastiCache)
- `AWS_REGION` - AWS region (default: ap-south-1)
- `AWS_ACCESS_KEY_ID` - For S3 uploads (optional for ECS with IAM role)
- `AWS_SECRET_ACCESS_KEY` - For S3 uploads (optional for ECS with IAM role)
- `S3_BUCKET` - S3 bucket name
- `SMS_PROVIDER` - One of: console, twilio, msg91, aws-sns
- Provider-specific: `TWILIO_*`, `MSG91_*` credentials
- `GOOGLE_MAPS_API_KEY` - For maps/routing
- `FIREBASE_SERVICE_ACCOUNT_PATH` - For push notifications
- `CORS_ORIGIN` - Comma-separated list of allowed domains
- `LOG_LEVEL` - info or warn (production)

**Optional env vars:**
- `REDIS_ENABLED` - Enable/disable Redis (default: false)
- `AWS_LOCATION_ENABLED` - Enable AWS Location Service (default: false)
- `RATE_LIMIT_WINDOW_MS` - Rate limit window (default: 900000ms)
- `RATE_LIMIT_MAX_REQUESTS` - Max requests per window (default: 100)
- `OTP_EXPIRY_MINUTES` - OTP validity (default: 5)
- `OTP_LENGTH` - OTP digit count (default: 6)
- `OTP_MAX_ATTEMPTS` - Failed OTP attempts before lockout (default: 3)
- `ENABLE_SECURITY_HEADERS` - Helmet headers (default: true)
- `ENABLE_RATE_LIMITING` - Rate limiter middleware (default: true)
- `ENABLE_REQUEST_LOGGING` - Request logging middleware (default: true)

## Webhooks & Callbacks

**Incoming:**
- None detected

**Outgoing:**
- None detected

---

*Integration audit: 2026-02-19*
