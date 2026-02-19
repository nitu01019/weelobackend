# Coding Conventions

**Analysis Date:** 2026-02-19

## Naming Patterns

**Files:**
- Kebab-case with descriptive names: `transporter-availability-toggle.test.ts`, `error.middleware.ts`, `auth.middleware.ts`
- Services follow pattern: `{entity}.service.ts` e.g., `logger.service.ts`, `transporter-online.service.ts`, `s3-upload.service.ts`
- Middleware files follow pattern: `{purpose}.middleware.ts` e.g., `error.middleware.ts`, `auth.middleware.ts`, `rate-limiter.middleware.ts`
- Route files follow pattern: `{entity}.routes.ts` e.g., `health.routes.ts`
- Utility files follow pattern: `{purpose}.utils.ts` e.g., `validation.utils.ts`, `geospatial.utils.ts`, `crypto.utils.ts`
- Interface/type files: `{entity}.types.ts` e.g., `error.types.ts`, `api.types.ts`
- Job files follow pattern: `{action}-{entity}.job.ts` e.g., `cleanup-expired-orders.job.ts`

**Classes and Functions:**
- PascalCase for classes: `AppError`, `ValidationError`, `NotFoundError`, `ApiResponse`, `UserRole`
- camelCase for functions and methods: `authMiddleware()`, `errorHandler()`, `asyncHandler()`, `parseEnv()`, `sanitizeLogData()`
- Constructor parameters use camelCase: `statusCode`, `isOperational`, `userId`, `retryAfter`
- Public properties use camelCase: `statusCode`, `details`, `message`, `timestamp`

**Variables:**
- camelCase throughout: `authHeader`, `finalValue`, `presenceData`, `transporterId`, `isOperational`
- Constants use UPPER_SNAKE_CASE: `SENSITIVE_FIELDS`, `ONLINE_TRANSPORTERS_SET`, `TRANSPORTER_PRESENCE_KEY`, `PRESENCE_TTL_SECONDS`, `HTTP_STATUS`
- Boolean variables prefixed with `is` or `has`: `isProduction`, `isOperational`, `isRequired`, `hasNext`, `hasPrev`
- Factory functions return lowercase singleton: `logger`, `redisService`

**Types:**
- PascalCase for interfaces and types: `SuccessResponse<T>`, `ValidationErrorDetail`, `ResponseMeta`, `PaginationMeta`, `EnvVar`, `ValidationResult`
- Enum members in PascalCase: `UserRole.CUSTOMER`, `ErrorCode.INTERNAL_ERROR`, `HTTP_STATUS.OK`

## Code Style

**Formatting:**
- No automatic formatter detected (eslint is present but no prettier config found)
- Line length target: Generally kept under 100 characters
- Import statements are organized and specific
- TypeScript strict: false (non-strict compilation), but errors are handled carefully
- Uses triple-slash comments for major sections and features

**Linting:**
- Tool: ESLint (^8.56.0) - `lint` script runs `eslint src/**/*.ts`
- Fix command available: `npm run lint:fix`
- No explicit ESLint config file found in repo root (may be in package.json)

**Comments:**
- Extensive JSDoc-style comments on all public classes and functions
- Section headers use box-drawing format for visual organization:
```
/**
 * =============================================================================
 * SECTION NAME
 * =============================================================================
 */
```
- Each file starts with a header explaining purpose and usage
- Inline comments explain WHY, not WHAT
- Security-related comments marked with `SECURITY:` prefix
- Implementation notes marked with `CODING STANDARDS:` prefix

**Error Handling Comments:**
- All error classes have clear docstring with usage examples
- Error type guards exported as functions: `isOperationalError()`, `isValidationError()`, `isNotFoundError()`

## Import Organization

**Order:**
1. External packages (express, jsonwebtoken, winston)
2. Internal absolute imports (`@/`, `@core/`, `@modules/`, `@shared/`)
3. Relative imports

**Path Aliases:**
- `@/*` → `./` (root of src)
- `@core` → `./core`
- `@core/*` → `./core/*`
- `@modules/*` → `./modules/*`
- `@shared/*` → `./shared/*`
- `@config/*` → `./config/*`

**Example from auth.middleware.ts:**
```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/environment';
import { AppError } from '../types/error.types';
import { logger } from '../services/logger.service';
```

## Error Handling

**Pattern:**
- All operational errors extend `AppError` base class: `BadRequestError`, `ValidationError`, `UnauthorizedError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `InternalError`
- Throw specific error types in services, never raw Error
- Error handler middleware (`errorHandler()`) catches and converts to standardized JSON response
- Use `asyncHandler()` wrapper for async route handlers to catch promise rejections
- Async errors automatically passed to next() for centralized handling

**Error Response Format:**
```typescript
{
  success: false,
  error: {
    code: string,
    message: string,
    details?: Record<string, unknown>,
    timestamp: string,
    stack?: string  // Dev only
  }
}
```

**Specific Error Classes with Built-in Context:**
- `ValidationError` - accepts array of field-level errors
- `BookingNotFoundError(bookingId)` - domain-specific with contextual details
- `RateLimitError(message, retryAfter)` - includes retry timing

## Logging

**Framework:** Winston (^3.11.0)

**Pattern:**
- Use `logger` singleton from `shared/services/logger.service.ts`
- Export convenience methods: `logInfo()`, `logError()`, `logWarn()`, `logDebug()`
- Always pass metadata as second parameter: `logger.info(message, { userId, path })`
- Automatic redaction of sensitive fields: `password`, `token`, `accessToken`, `refreshToken`, `secret`, `apiKey`, `authorization`, `otp`, `pin`

**Log Levels:**
- `error` - Failed operations, exceptions
- `warn` - Risky situations, deprecated usage
- `info` - Important lifecycle events (startup, shutdown, state changes)
- `debug` - Detailed diagnostic information

**Environment Configuration:**
- Level controlled by `LOG_LEVEL` env var (default: 'info')
- Production: Errors written to `logs/error.log`, combined logs to `logs/combined.log` (5MB rotation, max 5 files)
- Development: Console output only

**Security Rules:**
```typescript
// Sanitization example
const sanitizedMeta = sanitizeLogData(meta);
// Replaces any key containing 'password', 'token', etc. with '[REDACTED]'
```

## Function Design

**Size:** Keep functions under 50 lines when possible
- Services handle business logic, break into multiple methods
- Middleware functions handle single concern
- Error handling cleanly separated

**Parameters:**
- Prefer named objects over multiple parameters (max 3 positional args)
- Use destructuring for request/response parameters
- Provide defaults for optional parameters

**Return Values:**
- Use union types for functions that might error: `Promise<T | AppError>`
- Prefer throwing errors over returning them in catch paths
- For async operations, use try/catch pattern consistently

## Module Design

**Exports:**
- Each module exports a single primary class or function
- Use named exports for utilities and constants
- Re-export from index files (barrel export pattern)

**Barrel Files:**
- Pattern: `src/core/index.ts` re-exports all core utilities
- `src/core/errors/index.ts` re-exports all error classes
- `src/core/responses/index.ts` re-exports response builders
- Simplifies imports throughout codebase

**Directory Structure Pattern:**
```
src/
├── core/              # Core utilities, errors, responses, config
├── config/            # Environment and startup configuration
├── modules/           # Feature-based modules (order, customer, booking)
└── shared/            # Cross-cutting concerns (services, middleware, types)
    ├── middleware/
    ├── services/
    ├── types/
    ├── utils/
    ├── database/
    └── routes/
```

## Middleware Pattern

**Application Order (from server.ts):**
1. Security middleware (helmet, CORS, request validation)
2. Request logging middleware
3. Request parsing (express.json, express.urlencoded)
4. Rate limiting middleware
5. Authentication middleware (optional depending on route)
6. Route handlers
7. 404 handler
8. Error handler (always last)

**Custom Middleware Signature:**
```typescript
function customMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Logic here
  next();  // Pass to next middleware
  // OR: next(error);  // Pass error to error handler
}
```

## Database and ORM

**ORM:** Prisma (^5.22.0)
- Schema-driven database design
- Client available as: `import { prismaClient } from '@shared/database/prisma.service'`
- Migrations managed via `npm run db:migrate`
- Always check for null/undefined on queries

**Repository Pattern:**
- Interface defined: `src/shared/database/repository.interface.ts`
- Encapsulates all database operations
- Methods use async/await pattern

## API Response Pattern

**Builder Class:** `ApiResponse` in `src/core/responses/ApiResponse.ts`

**Static Methods:**
- `ApiResponse.success(res, data, message?, meta?)` - 200 OK
- `ApiResponse.created(res, data, message?)` - 201 Created
- `ApiResponse.noContent(res)` - 204 No Content
- `ApiResponse.paginated(res, data, pagination, message?)` - Paginated list
- `ApiResponse.list(res, data, message?)` - Simple list with count
- `ApiResponse.ok(res, message?)` - Success message only
- `ApiResponse.download(res, buffer, filename, mimeType)` - File download
- `ApiResponse.stream(res, mimeType?)` - Stream response

**Usage Pattern:**
```typescript
return ApiResponse.success(res, { userId: '123' }, 'User retrieved');
// Returns:
{
  success: true,
  data: { userId: '123' },
  message: 'User retrieved',
  meta: { timestamp: '...' }
}
```

## Validation

**Framework:** Zod (^3.22.4)

**Pattern:**
- Define schemas as constants in module
- Use `ValidationError.fromZodError()` to convert parse errors
- Validate in route handlers before passing to services
- Never accept unvalidated input from clients

**Error Conversion:**
```typescript
try {
  const validated = schema.parse(data);
} catch (err: any) {
  throw ValidationError.fromZodError(err);
}
```

---

*Convention analysis: 2026-02-19*
