# 🏗️ Weelo Backend Architecture

> **Production-Ready Backend for Logistics & Transportation Platform**
> 
> Designed to scale to millions of users on AWS infrastructure.

---

## 📁 Project Structure

```
weelo-backend/
│
├── 📄 Configuration Files
│   ├── package.json           # Dependencies & scripts
│   ├── tsconfig.json          # TypeScript configuration
│   ├── Dockerfile             # Production container build
│   ├── docker-compose.yml     # Local development stack
│   ├── .env.example           # Environment template (development)
│   └── .env.production.example # Environment template (production)
│
├── 📁 scripts/
│   └── init-db.sql            # PostgreSQL schema initialization
│
└── 📁 src/
    │
    ├── 📄 server.ts           # Application entry point
    ├── 📄 cluster.ts          # Multi-core cluster manager
    │
    ├── 📁 core/               # 🎯 Core Framework (shared across all modules)
    │   ├── index.ts           # Barrel export
    │   ├── 📁 constants/      # Enums, status codes, regex patterns
    │   ├── 📁 errors/         # Custom error classes
    │   ├── 📁 responses/      # Standardized API responses
    │   └── 📁 config/         # Environment validation
    │
    ├── 📁 config/             # ⚙️ Configuration
    │   ├── environment.ts     # Environment config loader
    │   ├── aws.config.ts      # AWS services configuration
    │   └── production.config.ts # Production settings
    │
    ├── 📁 shared/             # 🔧 Shared Utilities & Services
    │   ├── 📁 database/       # Database abstraction layer
    │   │   ├── db.ts          # JSON database (development)
    │   │   └── repository.interface.ts # PostgreSQL-ready interfaces
    │   │
    │   ├── 📁 middleware/     # Express middleware
    │   │   ├── auth.middleware.ts      # JWT authentication
    │   │   ├── error.middleware.ts     # Global error handler
    │   │   ├── rate-limiter.middleware.ts # Rate limiting
    │   │   ├── security.middleware.ts  # Security headers
    │   │   ├── cache.middleware.ts     # Response caching
    │   │   └── request-logger.middleware.ts # Request logging
    │   │
    │   ├── 📁 services/       # Shared services
    │   │   ├── logger.service.ts    # Winston logger
    │   │   ├── cache.service.ts     # Redis cache
    │   │   ├── socket.service.ts    # WebSocket manager
    │   │   ├── fcm.service.ts       # Firebase push notifications
    │   │   └── queue.service.ts     # Job queue
    │   │
    │   ├── 📁 monitoring/     # Observability
    │   │   └── metrics.service.ts   # Prometheus metrics
    │   │
    │   ├── 📁 resilience/     # Fault tolerance
    │   │   ├── circuit-breaker.ts   # Circuit breaker pattern
    │   │   └── request-queue.ts     # Request queuing
    │   │
    │   ├── 📁 routes/         # Shared routes
    │   │   └── health.routes.ts     # Health check endpoints
    │   │
    │   ├── 📁 types/          # TypeScript type definitions
    │   │   ├── api.types.ts
    │   │   └── error.types.ts
    │   │
    │   └── 📁 utils/          # Utility functions
    │       ├── crypto.utils.ts      # Hashing, encryption
    │       └── validation.utils.ts  # Input validation
    │
    └── 📁 modules/            # 📦 Feature Modules
        │
        ├── 📁 auth/           # Authentication & OTP
        │   ├── index.ts
        │   ├── auth.routes.ts
        │   ├── auth.controller.ts
        │   ├── auth.service.ts
        │   ├── auth.schema.ts      # Zod validation schemas
        │   └── sms.service.ts
        │
        ├── 📁 user/           # User profiles
        │   ├── index.ts
        │   ├── user.routes.ts
        │   ├── user.controller.ts
        │   ├── user.service.ts
        │   └── user.schema.ts
        │
        ├── 📁 vehicle/        # Vehicle management
        │   ├── index.ts
        │   ├── vehicle.routes.ts
        │   ├── vehicle.controller.ts
        │   ├── vehicle.service.ts
        │   └── vehicle.schema.ts
        │
        ├── 📁 booking/        # Single-vehicle bookings
        │   ├── index.ts
        │   ├── booking.routes.ts
        │   ├── booking.controller.ts
        │   ├── booking.service.ts
        │   ├── booking.schema.ts
        │   └── order.service.ts    # Multi-vehicle orders
        │
        ├── 📁 driver/         # Driver operations
        │   ├── index.ts
        │   ├── driver.routes.ts
        │   └── driver.service.ts
        │
        ├── 📁 driver-auth/    # Driver-specific auth
        │   ├── driver-auth.routes.ts
        │   ├── driver-auth.controller.ts
        │   ├── driver-auth.service.ts
        │   └── driver-auth.schema.ts
        │
        ├── 📁 transporter/    # Transporter operations
        │   └── transporter.routes.ts
        │
        ├── 📁 tracking/       # GPS tracking
        │   ├── index.ts
        │   ├── tracking.routes.ts
        │   ├── tracking.controller.ts
        │   ├── tracking.service.ts
        │   └── tracking.schema.ts
        │
        ├── 📁 pricing/        # Fare calculation
        │   ├── index.ts
        │   ├── pricing.routes.ts
        │   ├── pricing.service.ts
        │   ├── pricing.schema.ts
        │   └── vehicle-catalog.ts
        │
        ├── 📁 broadcast/      # Booking broadcast system
        │   ├── index.ts
        │   ├── broadcast.routes.ts
        │   ├── broadcast.service.ts
        │   └── broadcast.schema.ts
        │
        ├── 📁 assignment/     # Driver-vehicle assignments
        │   ├── index.ts
        │   ├── assignment.routes.ts
        │   ├── assignment.controller.ts
        │   ├── assignment.service.ts
        │   └── assignment.schema.ts
        │
        ├── 📁 profile/        # User profile management
        │   ├── index.ts
        │   ├── profile.routes.ts
        │   ├── profile.service.ts
        │   └── profile.schema.ts
        │
        └── 📁 notification/   # Push notifications
            └── notification.routes.ts
```

---

## 🎯 Design Principles

### 1. **Modular Architecture**
Each feature is a self-contained module with:
- `*.routes.ts` - Route definitions
- `*.controller.ts` - Request handling (thin layer)
- `*.service.ts` - Business logic
- `*.schema.ts` - Zod validation schemas
- `index.ts` - Barrel exports

### 2. **Single Responsibility**
- Controllers: Parse request → Call service → Return response
- Services: Business logic, database operations
- Middleware: Cross-cutting concerns (auth, logging, etc.)

### 3. **Dependency Injection Ready**
Services are exported as singletons but can be refactored for DI containers.

### 4. **Type Safety**
- Full TypeScript coverage
- Zod for runtime validation
- Strict null checks enabled

---

## 🔐 Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTHENTICATION FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   1. SEND OTP                                                   │
│   ─────────────                                                 │
│   POST /api/v1/auth/send-otp                                    │
│   { "phone": "9876543210", "role": "customer" }                │
│                    │                                            │
│                    ▼                                            │
│   ┌──────────────────────────────┐                             │
│   │   Generate 6-digit OTP       │                             │
│   │   Store with 5-min expiry    │                             │
│   │   Send via SMS provider      │                             │
│   └──────────────────────────────┘                             │
│                                                                 │
│   2. VERIFY OTP                                                 │
│   ─────────────                                                 │
│   POST /api/v1/auth/verify-otp                                  │
│   { "phone": "9876543210", "otp": "123456", "role": "customer" }│
│                    │                                            │
│                    ▼                                            │
│   ┌──────────────────────────────┐                             │
│   │   Validate OTP               │                             │
│   │   Create/Update user         │                             │
│   │   Generate JWT tokens        │                             │
│   └──────────────────────────────┘                             │
│                    │                                            │
│                    ▼                                            │
│   Response:                                                     │
│   {                                                             │
│     "tokens": {                                                 │
│       "accessToken": "eyJ...",   // 15 min expiry              │
│       "refreshToken": "eyJ..."   // 7 day expiry               │
│     },                                                          │
│     "user": { ... }                                             │
│   }                                                             │
│                                                                 │
│   3. AUTHENTICATED REQUESTS                                     │
│   ─────────────────────────                                     │
│   Authorization: Bearer <accessToken>                           │
│                                                                 │
│   4. REFRESH TOKEN                                              │
│   ─────────────────                                             │
│   POST /api/v1/auth/refresh                                     │
│   { "refreshToken": "eyJ..." }                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📊 Booking Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    BOOKING STATUS FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   PENDING ──────► CONFIRMED ──────► ASSIGNED                    │
│      │                │                 │                       │
│      │                │                 ▼                       │
│      │                │          DRIVER_EN_ROUTE                │
│      │                │                 │                       │
│      │                │                 ▼                       │
│      │                │            AT_PICKUP                    │
│      │                │                 │                       │
│      │                │                 ▼                       │
│      │                │            IN_TRANSIT                   │
│      │                │                 │                       │
│      │                │                 ▼                       │
│      │                │            AT_DROPOFF                   │
│      │                │                 │                       │
│      │                │                 ▼                       │
│      │                │            COMPLETED ✓                  │
│      │                │                                         │
│      └────────────────┴─────────► CANCELLED ✗                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🌐 API Endpoints Overview

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/send-otp` | Send OTP to phone |
| POST | `/api/v1/auth/verify-otp` | Verify OTP & get tokens |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| POST | `/api/v1/auth/logout` | Logout user |

### Bookings (Customer)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/bookings` | Create new booking |
| GET | `/api/v1/bookings` | List my bookings |
| GET | `/api/v1/bookings/:id` | Get booking details |
| PUT | `/api/v1/bookings/:id/cancel` | Cancel booking |

### Vehicles (Transporter)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/vehicles` | List my vehicles |
| POST | `/api/v1/vehicles` | Add new vehicle |
| PUT | `/api/v1/vehicles/:id` | Update vehicle |
| DELETE | `/api/v1/vehicles/:id` | Remove vehicle |

### Tracking
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/tracking/location` | Update driver location |
| GET | `/api/v1/tracking/:bookingId` | Get booking location |
| WS | `/socket` | Real-time location updates |

### Health & Monitoring
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Quick health check |
| GET | `/health/ready` | Readiness probe |
| GET | `/health/detailed` | Full diagnostics |
| GET | `/metrics` | Prometheus metrics |

---

## 🚀 Scalability Features

### 1. **Multi-Core Clustering**
```bash
npm run start:cluster
```
- Utilizes all CPU cores
- Auto-restart on worker crash
- Zero-downtime deployments

### 2. **Circuit Breakers**
Protects against cascading failures:
- SMS Service
- External APIs
- Database (when using external DB)
- FCM Push Notifications

### 3. **Request Queuing**
High-load protection:
- Default queue: 200 concurrent, 2000 max queued
- Booking queue: 50 concurrent (priority)
- Tracking queue: 500 concurrent (high throughput)
- Auth queue: 100 concurrent (security)

### 4. **Redis Caching**
- Session storage
- OTP storage
- Rate limiting
- Response caching
- Real-time pub/sub

### 5. **Database Connection Pooling**
- Min: 5 connections
- Max: 50 connections
- Idle timeout: 30 seconds

---

## 🔒 Security Features

- ✅ Helmet.js security headers
- ✅ Rate limiting (configurable per endpoint)
- ✅ JWT authentication with refresh tokens
- ✅ Input validation (Zod)
- ✅ SQL injection protection (parameterized queries)
- ✅ XSS protection
- ✅ CORS configuration
- ✅ Request size limits

---

## 📈 Monitoring & Observability

### Prometheus Metrics
```bash
curl http://localhost:3000/metrics
```
- HTTP request duration (histogram)
- Request count by status code
- Database query times
- Cache hit/miss ratio
- Memory usage
- Event loop lag

### Health Endpoints
```bash
# Quick check (load balancer)
curl http://localhost:3000/health

# Readiness (Kubernetes)
curl http://localhost:3000/health/ready

# Full diagnostics
curl http://localhost:3000/health/detailed
```

### Logging
- Winston logger
- JSON format for production
- Log levels: error, warn, info, debug
- Request ID tracking

---

## 🐳 Docker Deployment

### Development
```bash
# Start full stack (API + PostgreSQL + Redis)
docker-compose up -d

# View logs
docker-compose logs -f api

# Stop
docker-compose down
```

### Production
```bash
# Build image
docker build -t weelo-backend:latest .

# Run with external services
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgresql://... \
  -e REDIS_HOST=... \
  weelo-backend:latest
```

---

## ☁️ AWS Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    AWS PRODUCTION ARCHITECTURE                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────┐     ┌─────────────────────────────────────┐  │
│   │  Route 53   │────►│        CloudFront CDN              │  │
│   │    DNS      │     │   (Static assets, API caching)     │  │
│   └─────────────┘     └──────────────┬──────────────────────┘  │
│                                      │                         │
│                                      ▼                         │
│                       ┌─────────────────────────────────────┐  │
│                       │   Application Load Balancer (ALB)   │  │
│                       │      (SSL termination, routing)     │  │
│                       └──────────────┬──────────────────────┘  │
│                                      │                         │
│            ┌─────────────────────────┼─────────────────────┐   │
│            │                         │                     │   │
│            ▼                         ▼                     ▼   │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────┐ │
│   │  ECS Fargate    │   │  ECS Fargate    │   │ ECS Fargate │ │
│   │   Container 1   │   │   Container 2   │   │ Container N │ │
│   │   (Node.js)     │   │   (Node.js)     │   │ (Node.js)   │ │
│   └────────┬────────┘   └────────┬────────┘   └──────┬──────┘ │
│            │                     │                    │        │
│            └─────────────────────┼────────────────────┘        │
│                                  │                             │
│                    ┌─────────────┴─────────────┐               │
│                    │                           │               │
│                    ▼                           ▼               │
│   ┌─────────────────────────┐   ┌─────────────────────────┐   │
│   │   ElastiCache Redis     │   │     RDS PostgreSQL      │   │
│   │  (Sessions, Cache, PubSub)│   │  (Primary + Replicas)   │   │
│   └─────────────────────────┘   └─────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📝 Coding Standards

### File Naming
- `kebab-case` for files: `user.service.ts`
- `PascalCase` for classes: `UserService`
- `camelCase` for functions: `getUserById`
- `SCREAMING_SNAKE_CASE` for constants: `MAX_RETRY_COUNT`

### Code Organization
```typescript
/**
 * =============================================================================
 * MODULE HEADER - Description of the module
 * =============================================================================
 */

// 1. External imports
import express from 'express';
import { z } from 'zod';

// 2. Internal imports (absolute paths preferred)
import { UserRole } from '@core/constants';
import { logger } from '@shared/services/logger.service';

// 3. Types/Interfaces
interface User { ... }

// 4. Constants
const MAX_ATTEMPTS = 3;

// 5. Main code (classes, functions)
export class UserService { ... }

// 6. Helper functions (private)
function validateInput() { ... }
```

### Error Handling
```typescript
// ✅ Good - Use custom error classes
throw new NotFoundError('User not found', ErrorCode.AUTH_USER_NOT_FOUND);

// ❌ Bad - Generic errors
throw new Error('User not found');
```

### Response Format
```typescript
// ✅ Good - Use ApiResponse
return ApiResponse.success(res, user, 'User retrieved successfully');

// ❌ Bad - Manual JSON
return res.json({ success: true, data: user });
```

---

## 🧪 Testing

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage
```

---

## 📚 Quick Reference

### Environment Variables
See `.env.production.example` for complete list.

### NPM Scripts
```bash
npm run dev          # Development (hot reload)
npm run build        # Build TypeScript
npm run start        # Single process
npm run start:cluster # Multi-core production
npm run start:prod   # Production mode
npm run docker:dev   # Docker development stack
npm run health       # Check health endpoint
npm run metrics      # View metrics
```

### Key Files to Edit
| Task | File(s) |
|------|---------|
| Add new endpoint | `src/modules/<module>/<module>.routes.ts` |
| Add business logic | `src/modules/<module>/<module>.service.ts` |
| Add validation | `src/modules/<module>/<module>.schema.ts` |
| Add constant/enum | `src/core/constants/index.ts` |
| Add error type | `src/core/errors/AppError.ts` |
| Change config | `src/config/environment.ts` |

---

*Last updated: January 2024*
*Version: 2.0.0*
