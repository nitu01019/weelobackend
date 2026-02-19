# Technology Stack

**Analysis Date:** 2026-02-19

## Languages

**Primary:**
- TypeScript 5.3.3 - All application code, strict configuration with `"strict": false` for flexibility

**Secondary:**
- JavaScript - Legacy scripts, Prisma configuration, ecosystem files

## Runtime

**Environment:**
- Node.js 20.x (specified in `package.json` engines: `">=18.0.0"`)

**Package Manager:**
- npm 10+ (inferred from package-lock.json v3 format)
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Express.js 4.18.2 - HTTP API server, routing, middleware stack

**Database:**
- Prisma 5.22.0 - ORM layer with PostgreSQL driver, migrations, type-safe queries
- PostgreSQL 15+ (specified in docker-compose as postgres:15-alpine)

**Caching/Sessions:**
- Redis 7.x - Session storage, rate limiting, geospatial queries, pub/sub messaging
- ioredis 5.9.2 - Redis client library
- redis 4.6.12 - Alternative Redis client (legacy, appears in package.json)

**Real-time Communication:**
- Socket.io 4.7.2 - WebSocket support for live tracking and broadcasts

**Authentication & Security:**
- jsonwebtoken 9.0.2 - JWT token generation and verification
- bcryptjs 2.4.3 - Password hashing and verification
- helmet 7.1.0 - Security headers (XSS, CSRF, clickjacking protection)
- express-rate-limit 7.1.5 - Rate limiting middleware

**File Uploads:**
- multer 2.0.2 - Multipart form data handling for file uploads

**Validation:**
- zod 3.22.4 - Schema validation and type inference

**Utilities:**
- uuid 9.0.1 - UUID generation for resource IDs
- compression 1.7.4 - gzip compression middleware
- cors 2.8.5 - Cross-Origin Resource Sharing middleware
- dotenv 16.3.1 - Environment variable loading

**Testing:**
- Jest 29.7.0 - Test runner and framework
- ts-jest 29.4.6 - Jest TypeScript preprocessor
- @types/jest 29.5.14 - Jest type definitions

**Development:**
- ts-node-dev 2.0.0 - TypeScript development server with hot reload
- TypeScript 5.3.3 - Compiler and type checking
- ESLint 8.56.0 - Code linting with TypeScript support
  - @typescript-eslint/parser 6.15.0 - TypeScript parser
  - @typescript-eslint/eslint-plugin 6.15.0 - TypeScript rules

## Key Dependencies

**Critical:**
- @prisma/client 5.22.0 - Database ORM, provides type-safe database access and migrations
- ioredis 5.9.2 - Redis connection pooling and high-performance operations
- express 4.18.2 - Web framework, the entire request/response routing foundation
- firebase-admin 13.6.0 - Push notifications via Firebase Cloud Messaging (FCM)

**Infrastructure:**
- @aws-sdk/client-s3 3.978.0 - AWS S3 file uploads for driver photos and documents
- @aws-sdk/s3-request-presigner 3.978.0 - Pre-signed URL generation for direct client uploads
- @aws-sdk/client-sns 3.975.0 - AWS SNS for SMS delivery (India)
- @aws-sdk/client-location 3.975.0 - AWS Location Service for real-time routing (optional)

**Monitoring & Logging:**
- winston 3.11.0 - Structured logging across all services

## Configuration

**Environment:**
- Loaded from `.env` file (development) or environment variables (production)
- `.env.example` and `.env.production.example` provide templates
- Configuration centralized in `src/config/environment.ts`

**Build:**
- `tsconfig.json` - TypeScript compilation settings (ES2022 target, no strict mode)
- `jest.config.js` - Jest test configuration
- `docker-compose.yml` - Local development stack (PostgreSQL 15, Redis 7, Node 20)
- `Dockerfile` - Multi-stage production build
- `ecosystem.config.js` - PM2 cluster process management (production)

## Platform Requirements

**Development:**
- Node.js 20.x
- PostgreSQL 15+ (or Docker)
- Redis 7+ (or Docker)
- npm 10+

**Production:**
- Node.js 20.x Alpine Linux (Docker image)
- AWS RDS PostgreSQL (database)
- AWS ElastiCache Redis (caching)
- AWS ECS (container orchestration)
- AWS S3 (file storage)
- AWS SNS (SMS delivery)
- AWS Location Service (optional, for routing)

---

*Stack analysis: 2026-02-19*
