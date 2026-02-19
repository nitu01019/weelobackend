# Architecture

**Analysis Date:** 2026-02-19

## Pattern Overview

**Overall:** Modular Layered Architecture with Domain-Driven Design (DDD)

**Key Characteristics:**
- Express.js backend serving dual clients: Customer App and Captain App (transporters/drivers)
- Database-agnostic service layer (PostgreSQL with Prisma ORM)
- Real-time WebSocket support for tracking and notifications
- Horizontal scaling ready with cluster mode (multi-core workers)
- Clear separation of concerns: routes → controllers → services → database
- Redis integration for distributed state management and OTP storage

## Layers

**HTTP Server Layer:**
- Purpose: Entry point, middleware execution, request/response handling
- Location: `src/server.ts`, `src/cluster.ts`
- Contains: Express app initialization, SSL/TLS setup, middleware stack, route registration
- Depends on: All middleware, all route modules, configuration
- Used by: External clients via HTTP/HTTPS

**Route Layer:**
- Purpose: Define API endpoints, request validation, route composition
- Location: `src/modules/*/[module].routes.ts` (20+ route files)
- Contains: Express Router definitions, endpoint method bindings, schema validation decorators
- Depends on: Controllers, middleware, validation schemas
- Used by: Express app, clients making HTTP requests

**Controller Layer:**
- Purpose: Handle HTTP request/response, delegate to services
- Location: `src/modules/*/[module].controller.ts`
- Contains: Async request handlers wrapped in asyncHandler, response formatting
- Depends on: Services, validation utilities, response builders
- Used by: Routes layer

**Service Layer (Business Logic):**
- Purpose: Core business logic, data processing, orchestration
- Location: `src/modules/*/[module].service.ts`
- Contains: Feature-specific logic (auth, booking, assignment, tracking, etc.)
- Depends on: Database layer, shared services, utilities
- Used by: Controllers, other services

**Shared Services Layer:**
- Purpose: Cross-cutting concerns, infrastructure utilities
- Location: `src/shared/services/*` (14 service files)
- Contains: Redis management, WebSocket communication, FCM push notifications, S3 uploads, Google Maps integration, queue operations, caching, logger
- Depends on: External libraries, configuration
- Used by: All modules, other shared services

**Database Layer:**
- Purpose: Data persistence and querying abstraction
- Location: `src/shared/database/prisma.service.ts`, `src/shared/database/db.ts`
- Contains: Prisma ORM client, query builders, transaction handlers, repository patterns
- Depends on: Prisma client, PostgreSQL driver
- Used by: Service layer for all data operations

**Middleware Layer:**
- Purpose: Request preprocessing, security, monitoring, error handling
- Location: `src/shared/middleware/*` (5 middleware files)
- Contains: Authentication (JWT), rate limiting, request logging, security headers, error handling
- Depends on: JWT library, configuration, logger
- Used by: Express app (registered globally or on specific routes)

**Core/Constants Layer:**
- Purpose: Centralized definitions, error codes, enums, validation
- Location: `src/core/constants/index.ts`, `src/core/errors/AppError.ts`, `src/core/responses/ApiResponse.ts`
- Contains: UserRole, BookingStatus, VehicleStatus enums; ErrorCode constants; HTTP status codes; error and response classes
- Depends on: Nothing (foundation layer)
- Used by: All other layers

## Data Flow

**User Authentication Flow:**

1. Client POSTs phone number to `POST /api/v1/auth/send-otp`
2. Routes layer receives request → auth.routes.ts
3. Controller invokes authService.sendOtp()
4. Service generates OTP, stores in Redis (fallback: in-memory), logs to console
5. Response returned with expiresIn (300s)
6. Client receives SMS via SNS (production) or logs (development)
7. Client POSTs phone + OTP to `POST /api/v1/auth/verify-otp`
8. Service queries Redis for stored OTP, validates match
9. JWT access/refresh tokens generated via config.jwt.secret
10. User record created/retrieved from PostgreSQL via prismaClient
11. Response includes tokens + user profile

**Booking Creation Flow (Customer → Transporter Match):**

1. Customer POSTs booking request to `POST /api/v1/bookings`
2. Routes authenticate customer via authMiddleware (JWT validation)
3. Controller validates input via Zod schema, invokes bookingService.createBooking()
4. Service executes:
   - Creates booking record in PostgreSQL (status: PENDING)
   - Retrieves transporters matching vehicle type via geospatial query (progressive radius: 10km → 25km → 50km → 75km)
   - Emits Socket.IO event to matched transporters via emitToUser()
   - Sends FCM push notifications via fcmService
   - Sets Redis timer for 120s timeout (booking expires if unfilled)
5. Transporter receives Socket event + FCM push
6. Transporter POSTs acceptance to `POST /api/v1/assignments`
7. Assignment service updates booking status: CONFIRMED
8. Emits update to customer via Socket.IO
9. On timeout (120s), cleanup job expires booking, notifies customer

**Real-Time Location Tracking Flow:**

1. Driver connects via WebSocket (Socket.IO handshake)
2. Socket service adds to connected users map, stores userId + role
3. Driver POSTs location update to `POST /api/v1/tracking`
4. Tracking service:
   - Stores location in PostgreSQL
   - Emits Socket event to customer of active booking (real-time update)
   - Emits to transporter dashboard
5. Customer/Transporter WebSocket listener updates map marker in real-time (no polling)
6. On trip completion, socket emits cleanup

**Order Management Flow (Multi-Truck Orders):**

1. Customer creates order with multiple truck types: `POST /api/v1/orders`
2. Order service creates Order record with status PENDING
3. For each truck type in order, creates TruckRequest records
4. Broadcasts TruckRequest separately to matching transporters (each gets independent Socket event)
5. Transporter accepts one truck type: `POST /api/v1/orders/:id/accept`
6. TruckRequest status → ACCEPTED, Assignment created
7. When all trucks fulfilled or timeout hits, Order status → COMPLETED/EXPIRED

**State Management:**

- **Transient State (Redis):** OTPs, session tokens, temporary booking broadcasts, rate limit counters
- **Persistent State (PostgreSQL):** Users, vehicles, bookings, assignments, orders, truck requests, tracking history
- **In-Memory State (Node.js):** Active WebSocket connections in socket.service singleton
- **Cache (Redis):** Transporter availability, vehicle status, fleet information via fleet-cache.service

## Key Abstractions

**AppError (Custom Error Class):**
- Purpose: Standardized error handling across all layers
- Examples: `src/core/errors/AppError.ts`, used in all services
- Pattern: Thrown with statusCode + ErrorCode (e.g., NotFoundError, ValidationError, ConflictError)
- Caught globally by errorHandler middleware, converted to JSON response

**ApiResponse (Response Builder):**
- Purpose: Consistent API response format
- Examples: `src/core/responses/ApiResponse.ts`, called in all controllers
- Pattern: Static methods success(), created(), paginated() return standardized { success, data, meta }

**Zod Schemas (Input Validation):**
- Purpose: Runtime validation of request payloads
- Examples: `src/modules/*/[module].schema.ts` (10+ schema files)
- Pattern: Define schema once, reuse in routes + services; validateRequest() middleware validates before controller

**Service Singletons:**
- Purpose: Shared infrastructure with single instance across app
- Examples: redisService, fcmService, socketService, logger, prismaClient
- Pattern: Initialized at server startup in server.ts, dependency injected to services

**Middleware Chain:**
- Purpose: Cross-cutting concerns applied uniformly
- Pattern: requestIdMiddleware → compression → security headers → CORS → body parser → request logger → metrics → rate limiter → error handler
- Order matters: RequestID first (for tracing), rate limiter near end (before reaching route handler), error handler last (catches all)

**Module Pattern:**
- Purpose: Feature isolation, independent deployment-ready modules
- Structure: Each module (auth, booking, driver, etc.) has routes.ts + controller.ts + service.ts + schema.ts
- Dependencies: Module service depends on shared services and database only, not on other module services
- Exports: Index.ts file exports public contracts only

**Async Handler Wrapper:**
- Purpose: Automatic try-catch in route handlers, routes errors to global error handler
- Pattern: `asyncHandler(async (req, res, next) => { ... })` wraps each controller method
- Benefit: No try-catch boilerplate in controllers, automatic next(error) on exceptions

## Entry Points

**Server Entry Point:**
- Location: `src/server.ts`
- Triggers: Called by `npm run dev` (single process) or spawned by cluster.ts workers
- Responsibilities:
  - Initialize Express app
  - Load environment validation
  - Initialize Redis connection
  - Initialize FCM service
  - Register middleware stack
  - Register all route modules
  - Start HTTP/HTTPS server with SSL detection
  - Set up graceful shutdown handlers
  - Start background cleanup job for expired orders

**Cluster Entry Point:**
- Location: `src/cluster.ts`
- Triggers: Called by `npm run start:prod` or `npm run start:cluster`
- Responsibilities:
  - Check if primary or worker process
  - If primary: fork worker processes (one per CPU core), manage restart on crashes, broadcast messages
  - If worker: load and run server.ts
  - Graceful shutdown of all workers on SIGTERM/SIGINT

**Health Check Entry Point:**
- Location: `GET /health` endpoint in server.ts (no auth required)
- Returns: { status, environment, connectedUsers, database stats, redis status, security status }
- Used by: Load balancers, monitoring systems, Kubernetes probes

## Error Handling

**Strategy:** Layered error handling with distinction between operational and non-operational errors

**Patterns:**

1. **Service Layer Throws:**
   - Services throw AppError subclasses (NotFoundError, ValidationError, ConflictError, etc.)
   - Each error includes statusCode, ErrorCode constant, optional details object
   - Example: `throw new NotFoundError('Booking not found', ErrorCode.BOOKING_NOT_FOUND);`

2. **Controller Catches via asyncHandler:**
   - Controller method wrapped in asyncHandler() utility
   - Automatically catches any thrown error, calls next(error)
   - No explicit try-catch needed in controller

3. **Global Error Middleware:**
   - errorHandler middleware (src/shared/middleware/error.middleware.ts) catches all errors
   - Converts AppError to standardized JSON response with proper HTTP status
   - Non-operational errors (bug-type) logged with full stack, returned as 500
   - Operational errors (validation, not found) returned with specific status + code + message
   - Stack trace included in development only

4. **Error Response Format:**
   ```json
   {
     "success": false,
     "error": {
       "code": "BOOKING_NOT_FOUND",
       "message": "Booking not found",
       "details": { "bookingId": "abc123" },
       "timestamp": "2026-02-19T10:30:00Z",
       "stack": "... (development only)"
     }
   }
   ```

## Cross-Cutting Concerns

**Logging:** Winston logger (src/shared/services/logger.service.ts)
- Structured logging with log levels: debug, info, warn, error
- Request logging middleware logs method + path + response time
- Services log business logic milestones (booking created, driver assigned, etc.)
- Errors logged with stack traces in development

**Validation:** Zod runtime schemas (per-module)
- Input validation happens at route layer via validateRequest middleware
- Schemas defined per module (booking.schema.ts, auth.schema.ts, etc.)
- Failed validation returns 400 Bad Request with field-level errors

**Authentication:** JWT middleware (src/shared/middleware/auth.middleware.ts)
- authMiddleware validates Bearer token, extracts userId + role + phone
- Stored in req.user object for downstream use
- roleGuard() middleware restricts endpoints by user role (customer/transporter/driver)
- Token refresh via refresh token endpoint (no need to re-login)

**Rate Limiting:** Redis-backed rate limiter (src/shared/middleware/rate-limiter.middleware.ts)
- Global rate limiter: 100 req/15 min per IP
- OTP limiter: 5 OTPs/15 min per phone (prevents brute force)
- Auth limiter: 10 attempts/15 min per phone
- Uses Redis for distributed counting (works across multiple server instances)
- Falls back to in-memory if Redis unavailable

**Monitoring:** Metrics service (src/shared/monitoring/metrics.service.ts)
- metricsMiddleware tracks request count + response times + error rates
- Exposed via prometheus-compatible endpoint (for alerting/dashboards)
- Tracks by endpoint + status code

**Resilience:** Retry logic in queue service (src/shared/services/queue.service.ts)
- Background jobs retry on failure (e.g., push notifications)
- Exponential backoff: 1s → 2s → 4s (max 3 retries)

**WebSocket/Realtime:** Socket.IO service (src/shared/services/socket.service.ts)
- Maintains connection map of { userId → socketId }
- Broadcast patterns: emitToUser, emitToBooking, emitToRoom
- Automatic disconnection cleanup
- Fallback to polling if WebSocket unavailable (client-side)

## Module Dependencies

**auth module** → redisService, prismaClient, fcmService, config.jwt
**booking module** → prismaClient, socketService, fcmService, queueService, redisService, availabilityService, transporterOnlineService
**driver module** → prismaClient, socketService, fcmService, s3Service, googleMapsService
**assignment module** → prismaClient, socketService, fcmService
**tracking module** → prismaClient, socketService, queueService
**order module** → prismaClient, socketService, fcmService, queueService
**vehicle module** → prismaClient, s3Service
**pricing module** → googleMapsService, prismaClient
**notification module** → fcmService, redisService
**profile module** → prismaClient, s3Service
**All modules** → logger, errorHandler middleware

## Scaling Considerations

**Horizontal Scaling (Multiple Servers):**
- Cluster mode (src/cluster.ts) spreads load across CPU cores
- Redis maintains shared state (OTPs, locks, rate limits) across servers
- WebSocket session affinity required (use sticky sessions in load balancer)
- Database connection pooling via Prisma (max 10 connections by default)

**Vertical Scaling (Bigger Server):**
- Increase WORKERS env var to spawn more processes than cores
- Increase database connection pool in environment config
- Increase Redis connection pool

**Database Scaling:**
- Queries use pagination (limit + offset) to prevent full-table scans
- Indexes on frequently queried fields (userId, phone, bookingId, etc.) defined in Prisma schema
- Connection pooling prevents exhaustion

**WebSocket Scaling:**
- Socket.IO with Redis adapter maintains connections across servers
- Rooms/namespaces used to partition broadcast traffic (booking rooms, user rooms)

---

*Architecture analysis: 2026-02-19*
