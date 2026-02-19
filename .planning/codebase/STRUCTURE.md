# Codebase Structure

**Analysis Date:** 2026-02-19

## Directory Layout

```
weelo-backend/
├── src/                           # Source code root
│   ├── server.ts                  # Main Express app + HTTP/HTTPS setup
│   ├── cluster.ts                 # Multi-core cluster manager (production)
│   │
│   ├── config/                    # Environment configuration
│   │   └── environment.ts         # Centralized config loader
│   │
│   ├── core/                      # Core/foundation layer
│   │   ├── constants/             # Error codes, enums, status codes
│   │   ├── errors/                # AppError custom error classes
│   │   ├── responses/             # ApiResponse builders
│   │   ├── config/                # Environment validation
│   │   └── index.ts               # Barrel export
│   │
│   ├── shared/                    # Cross-cutting concerns
│   │   ├── database/              # Prisma ORM, database abstractions
│   │   ├── middleware/            # Request processing (auth, rate-limit, etc.)
│   │   ├── services/              # Infrastructure services (Redis, FCM, Socket.IO, etc.)
│   │   ├── jobs/                  # Background jobs (expired order cleanup)
│   │   ├── monitoring/            # Metrics collection
│   │   ├── routes/                # Shared routes (health checks)
│   │   ├── resilience/            # Retry logic, circuit breakers
│   │   ├── types/                 # Shared TypeScript interfaces
│   │   └── utils/                 # Helper utilities (validation, crypto, etc.)
│   │
│   └── modules/                   # Feature modules (DDD domains)
│       ├── auth/                  # Authentication (OTP, JWT)
│       ├── driver-auth/           # Separate auth for drivers
│       ├── profile/               # User profile management
│       ├── vehicle/               # Vehicle registration
│       ├── booking/               # Customer bookings (simple + order-based)
│       ├── order/                 # Multi-truck order system
│       ├── assignment/            # Truck-to-booking assignment
│       ├── driver/                # Driver dashboard
│       ├── tracking/              # Real-time GPS tracking
│       ├── pricing/               # Fare estimation
│       ├── broadcast/             # Booking broadcasts to transporters
│       ├── notification/          # FCM push notifications
│       ├── transporter/           # Transporter dashboard + stats
│       ├── customer/              # Customer-specific features
│       ├── rating/                # Customer ratings
│       ├── truck-hold/            # BookMyShow-style truck holding
│       ├── custom-booking/        # Long-term contract bookings
│       ├── routing/               # Geocoding + Google Maps
│       ├── driver-onboarding/     # Driver registration flow
│       └── user/                  # User utility operations
│
├── prisma/                        # Prisma ORM schema
│   └── schema.prisma              # Database schema definition
│
├── scripts/                       # Build/utility scripts
│
├── dist/                          # Compiled JavaScript (generated)
├── node_modules/                  # Dependencies (gitignored)
├── uploads/                       # User-uploaded files (temp storage)
│
├── package.json                   # Project dependencies + scripts
├── tsconfig.json                  # TypeScript compiler configuration
└── .env                           # Environment variables (gitignored)
```

## Directory Purposes

**src/:**
- Purpose: All TypeScript source code
- Contains: Express app, modules, services, middleware, types
- Key files: `server.ts` (entry point), `cluster.ts` (production scaling)

**src/config/:**
- Purpose: Environment configuration management
- Contains: environment.ts with centralized config loader
- Key files: `environment.ts` loads from process.env and creates config object

**src/core/:**
- Purpose: Foundation layer - errors, constants, response formats
- Contains:
  - constants/index.ts: ErrorCode enum, UserRole, BookingStatus, VehicleStatus, HTTP_STATUS
  - errors/AppError.ts: Custom error classes (NotFoundError, ValidationError, ConflictError, etc.)
  - responses/ApiResponse.ts: Static methods for formatting success/error responses
- Key files: All files in core/ used by entire application

**src/shared/database/:**
- Purpose: Database abstraction layer using Prisma ORM
- Contains:
  - prisma.service.ts: Prisma client instance + query builders + transaction handlers
  - db.ts: Type definitions for database records (UserRecord, BookingRecord, VehicleRecord, etc.)
  - repository.interface.ts: Repository pattern interfaces
- Key files: `prisma.service.ts` (main database access), `db.ts` (type contracts)

**src/shared/middleware/:**
- Purpose: HTTP request preprocessing and security
- Contains:
  - auth.middleware.ts: JWT validation, roleGuard for role-based access
  - rate-limiter.middleware.ts: Global + OTP + auth rate limits
  - error.middleware.ts: Global error handler, asyncHandler wrapper
  - request-logger.middleware.ts: HTTP request logging
  - security.middleware.ts: CORS, helmet, XSS prevention, input sanitization
- Key files: All 5 files are critical; applied to every request in server.ts

**src/shared/services/:**
- Purpose: Infrastructure services and shared business logic
- Contains:
  - logger.service.ts: Winston structured logging
  - redis.service.ts: Redis client + OTP storage + distributed locks
  - socket.service.ts: Socket.IO WebSocket server + connection management
  - fcm.service.ts: Firebase Cloud Messaging push notifications
  - google-maps.service.ts: Google Maps API (geocoding, distance matrix)
  - s3-upload.service.ts: AWS S3 file uploads
  - cache.service.ts: Caching layer (generic key-value)
  - fleet-cache.service.ts: Vehicle availability caching
  - queue.service.ts: Background job queue (for async tasks)
  - availability.service.ts: Transporter availability checks
  - transporter-online.service.ts: Transporter online status tracking
  - vehicle-key.service.ts: Vehicle access key generation
- Key files: `redis.service.ts` (critical for scaling), `socket.service.ts` (real-time), `logger.service.ts` (observability)

**src/shared/jobs/:**
- Purpose: Background job runners
- Contains: cleanup-expired-orders.job.ts (runs every 2 minutes, cleans up stale orders)
- Triggers: Started by server.ts on boot

**src/shared/monitoring/:**
- Purpose: Application observability and metrics
- Contains: metrics.service.ts (request metrics: count, duration, errors by endpoint)
- Exposed via: `/api/v1/metrics` endpoint (Prometheus format)

**src/shared/types/:**
- Purpose: Shared TypeScript interfaces
- Contains:
  - api.types.ts: ApiResponse, ApiError, ApiMeta, Coordinates, PaginationParams
  - error.types.ts: AppError details
- Used by: All layers for consistent type contracts

**src/shared/utils/:**
- Purpose: Helper utilities
- Contains:
  - validation.utils.ts: validateRequest middleware, validateSchema helper
  - crypto.utils.ts: Hash, encrypt, decrypt functions
  - geospatial.utils.ts: Distance calculations, coordinate operations
- Key files: `validation.utils.ts` (used by all route validation)

**src/modules/[module]/ (each feature module):**
- Purpose: Isolated feature implementation
- Standard structure:
  - `[module].routes.ts`: Express router, endpoint definitions, middleware binding
  - `[module].controller.ts`: HTTP request handlers (thin layer)
  - `[module].service.ts`: Business logic, data transformations, orchestration
  - `[module].schema.ts`: Zod validation schemas for inputs
  - `index.ts`: Barrel export of public contracts
  - Additional files: helpers, types, constants (feature-specific)
- Example: `src/modules/booking/`:
  - booking.routes.ts: 15+ endpoints (create, get, update, cancel, accept, etc.)
  - booking.controller.ts: Request handlers
  - booking.service.ts: Smart matching algorithm, timeout management, status transitions
  - booking.schema.ts: Zod schemas (createBookingSchema, getBookingsQuerySchema, etc.)
  - order.service.ts: Multi-truck order logic
  - booking-payload.helper.ts: Broadcast payload builder

**src/modules/auth/:**
- Purpose: Authentication system
- Files: auth.routes.ts, auth.controller.ts, auth.service.ts, auth.schema.ts, sms.service.ts
- Endpoints: /send-otp, /verify-otp, /refresh, /logout

**src/modules/driver/:**
- Purpose: Driver dashboard and earnings
- Files: driver.routes.ts (39KB!), driver.controller.ts, driver.service.ts, driver.schema.ts
- Endpoints: /dashboard, /earnings, /trips, /availability, /regenerate-urls

**src/modules/tracking/:**
- Purpose: Real-time GPS location tracking
- Files: tracking.routes.ts, tracking.controller.ts, tracking.service.ts
- Endpoints: /update-location, /get-tracking, WebSocket events

**prisma/:**
- Purpose: Database schema definition and migrations
- Contains: schema.prisma (PostgreSQL schema with all tables, relations, indices)
- Managed via: prisma migrate dev (dev), prisma db push (production)

## Key File Locations

**Entry Points:**
- `src/server.ts`: Main HTTP server (development: `npm run dev`)
- `src/cluster.ts`: Multi-core cluster manager (production: `npm run start:prod`)

**Configuration:**
- `src/config/environment.ts`: Environment variables + defaults + validation
- `src/core/constants/index.ts`: Application constants (error codes, statuses)
- `prisma/schema.prisma`: Database schema

**Core Logic:**
- `src/modules/booking/booking.service.ts`: Booking matching algorithm (progressive radius expansion, timeouts)
- `src/modules/auth/auth.service.ts`: OTP generation/verification, JWT token handling
- `src/modules/tracking/tracking.service.ts`: Real-time location updates
- `src/shared/database/prisma.service.ts`: All database queries via Prisma ORM

**Testing:**
- `src/__tests__/`: Test files (mirror src/ structure)

## Naming Conventions

**Files:**
- `[feature].routes.ts`: Express router definitions (kebab-case module, camelCase .routes)
- `[feature].controller.ts`: HTTP handlers (camelCase)
- `[feature].service.ts`: Business logic (camelCase)
- `[feature].schema.ts`: Zod validation schemas (camelCase)
- `[feature].middleware.ts`: Request middleware (camelCase)
- `[feature].types.ts`: Feature-specific types (camelCase)
- `[feature].utils.ts`: Helper functions (camelCase)

**Directories:**
- Module directories: kebab-case (e.g., `driver-auth`, `custom-booking`, `truck-hold`)
- Service directories: kebab-case or plural (e.g., `database`, `services`, `middleware`, `jobs`)

**Exports (index.ts files):**
- Each module has index.ts barrel file: `export { authController, authService };`
- Shared services exported individually: `export { redisService, socketService, fcmService };`
- Core exports via `src/core/index.ts`: `export * from './constants'; export * from './errors/AppError';`

**TypeScript Paths (tsconfig.json):**
- `@/*`: src directory (e.g., `@/config`, `@/utils`)
- `@core`: src/core (e.g., `@core/constants`, `@core/errors`)
- `@modules/*`: src/modules/[module] (e.g., `@modules/auth/auth.service`)
- `@shared/*`: src/shared (e.g., `@shared/database`, `@shared/services`)
- `@config/*`: src/config (e.g., `@config/environment`)

## Where to Add New Code

**New Feature Module:**
1. Create directory: `src/modules/[feature-name]/`
2. Add files:
   - `[feature-name].routes.ts`: Define endpoints, import controller methods
   - `[feature-name].controller.ts`: Create class with async methods, each wrapped in asyncHandler
   - `[feature-name].service.ts`: Implement business logic, export singleton instance
   - `[feature-name].schema.ts`: Define Zod schemas for request validation
   - `index.ts`: Export controller and service
3. Register in `src/server.ts`: `import { [feature]Router } from './modules/[feature-name]/[feature-name].routes'; app.use(`${API_PREFIX}/[feature-name]`, [feature]Router);`

**New Endpoint:**
1. Add method to `[module].service.ts` (business logic)
2. Add handler to `[module].controller.ts` (wrapped in asyncHandler)
3. Add route to `[module].routes.ts` (call controller method, apply middleware)
4. Add Zod schema to `[module].schema.ts` (if input validation needed)
5. Apply validateRequest middleware if payload validation needed
6. Test with `curl` or API client (Postman, Insomnia)

**New Middleware:**
1. Create file: `src/shared/middleware/[purpose].middleware.ts`
2. Export function signature: `export function [name]Middleware(req, res, next)`
3. Register in `src/server.ts`: `app.use([name]Middleware);` (order matters!)

**New Shared Service:**
1. Create file: `src/shared/services/[purpose].service.ts`
2. Create singleton: `export const [purpose]Service = new [Purpose]Service();`
3. Initialize in `src/server.ts` if async setup needed: `.then(() => { logger.info(...); })`
4. Inject into services via dependency: `import { [purpose]Service } from '@shared/services';`

**New Background Job:**
1. Create file: `src/shared/jobs/[purpose].job.ts`
2. Export starter function: `export function start[Purpose]Job()`
3. Call from `src/server.ts` server startup: `import('./shared/jobs/[purpose].job').then(({ start[Purpose]Job }) => start[Purpose]Job());`

**New Database Model:**
1. Add table/model to `prisma/schema.prisma`
2. Run: `npm run db:generate` (updates Prisma client types)
3. Create migration: `npm run db:migrate` (creates SQL migration)
4. Add repository methods to `src/shared/database/prisma.service.ts` if needed
5. Use via: `import { prismaClient } from '@shared/database/prisma.service';`

**Utilities:**
- Shared helpers: `src/shared/utils/[purpose].utils.ts`
- Feature-specific: `src/modules/[module]/[purpose].utils.ts` or `[purpose].helper.ts`
- Example: `src/modules/booking/booking-payload.helper.ts` (broadcast payload builder)

## Special Directories

**src/uploads/:**
- Purpose: Temporary file storage for uploads
- Generated: Yes (created at runtime)
- Committed: No (gitignored)
- Accessed via: S3 service (copies to S3, then local copy deleted)

**dist/:**
- Purpose: Compiled JavaScript output
- Generated: Yes (by `npm run build`)
- Committed: No (gitignored)
- Entry point: `dist/server.js` (production runtime)

**prisma/:**
- Purpose: Database schema and migrations
- Generated: Partly (migrations created by `prisma migrate dev`)
- Committed: Yes (schema.prisma + migrations/ folder)
- Critical for: Team collaboration, deployment consistency

**node_modules/:**
- Purpose: npm dependencies
- Generated: Yes (by `npm install`)
- Committed: No (gitignored)
- Lockfile: package-lock.json (committed for reproducibility)

**__tests__/:**
- Purpose: Test files (mirrors src/ structure)
- Generated: No (manually written)
- Committed: Yes (tests are source code)
- Run: `npm test` (Jest runner)

## Module Organization Example

**Booking Module (src/modules/booking/):**
```
booking/
├── booking.routes.ts          # 11KB - 15+ endpoints
├── booking.controller.ts      # 3KB - Request handlers
├── booking.service.ts         # 54KB - Core matching logic
├── booking.schema.ts          # 9KB - Zod schemas
├── order.service.ts           # 37KB - Multi-truck orders
├── booking-payload.helper.ts  # 4KB - Broadcast payload builder
└── index.ts                   # Barrel export
```

**Shared Services (src/shared/services/):**
```
services/
├── logger.service.ts          # 3KB - Winston logger
├── redis.service.ts           # 56KB - Redis client + OTP
├── socket.service.ts          # 30KB - WebSocket server
├── fcm.service.ts             # 19KB - Push notifications
├── google-maps.service.ts     # 23KB - Geocoding
├── s3-upload.service.ts       # 9KB - File uploads
├── cache.service.ts           # 13KB - Caching
├── fleet-cache.service.ts     # 29KB - Fleet availability
├── queue.service.ts           # 21KB - Background jobs
├── availability.service.ts    # 21KB - Availability checks
├── transporter-online.service.ts # 12KB - Online status
└── vehicle-key.service.ts     # 7KB - Access keys
```

---

*Structure analysis: 2026-02-19*
