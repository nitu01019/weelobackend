# 📏 WEELO BACKEND - CODING STANDARDS

This document defines the coding standards and conventions for the Weelo Backend.
All contributors must follow these guidelines for consistency.

---

## 📁 Module Structure

Every module MUST follow this structure:

```
src/modules/{module-name}/
├── index.ts              # Public exports
├── {module}.routes.ts    # Express routes
├── {module}.service.ts   # Business logic
├── {module}.schema.ts    # Zod validation schemas
└── {module}.controller.ts # Request handlers (optional)
```

### File Responsibilities

| File | Purpose |
|------|---------|
| `index.ts` | Export public APIs (router, service, schemas) |
| `*.routes.ts` | Define HTTP endpoints, middleware, call service |
| `*.service.ts` | Business logic, database operations |
| `*.schema.ts` | Zod schemas for request/response validation |
| `*.controller.ts` | Request handlers (for complex modules) |

---

## 📝 Naming Conventions

### Files
- Use **kebab-case** for folders: `my-module/`
- Use **dot notation** for files: `auth.service.ts`

### Variables & Functions
```typescript
// ✅ Good - camelCase
const userId = 'abc123';
function getUserById(id: string) {}

// ❌ Bad
const user_id = 'abc123';
function get_user_by_id(id: string) {}
```

### Classes & Interfaces
```typescript
// ✅ Good - PascalCase
class UserService {}
interface UserRecord {}
type CreateUserInput = {};

// ❌ Bad
class userService {}
interface user_record {}
```

### Constants
```typescript
// ✅ Good - UPPER_SNAKE_CASE for true constants
const MAX_RETRY_ATTEMPTS = 3;
const VALID_VEHICLE_TYPES = ['tipper', 'container'] as const;

// ✅ Good - camelCase for config objects
const config = { maxRetries: 3 };
```

---

## 📐 Code Style

### Imports Order
```typescript
// 1. Node.js built-in modules
import { createServer } from 'http';

// 2. External packages
import express from 'express';
import { z } from 'zod';

// 3. Internal modules (absolute paths)
import { config } from '../../config/environment';
import { logger } from '../../shared/services/logger.service';

// 4. Local imports (relative paths)
import { userService } from './user.service';
import { createUserSchema } from './user.schema';
```

### Function Documentation
```typescript
/**
 * Create a new booking and broadcast to transporters
 * 
 * @param userId - The customer's user ID
 * @param data - Booking creation data
 * @returns The created booking record
 * @throws AppError if validation fails
 */
async function createBooking(userId: string, data: CreateBookingInput): Promise<BookingRecord> {
  // Implementation
}
```

### Error Handling
```typescript
// ✅ Good - Use AppError for business errors
import { AppError } from '../../shared/types/error.types';

if (!user) {
  throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
}

// ✅ Good - Let middleware handle errors in routes
router.get('/', async (req, res, next) => {
  try {
    const result = await service.getData();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error); // Pass to error middleware
  }
});

// ❌ Bad - Don't catch and re-throw without reason
try {
  await service.getData();
} catch (error) {
  throw error; // Pointless
}
```

---

## 🔒 Schema Validation (Zod)

### Schema Definition
```typescript
// ✅ Good - Separate file with clear naming
// user.schema.ts

import { z } from 'zod';

/**
 * Schema for creating a user
 */
export const createUserSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100),
    email: z.string().email('Invalid email format'),
    phone: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid phone number')
  })
});

// Export type for use in service
export type CreateUserInput = z.infer<typeof createUserSchema>['body'];
```

### Using Schemas in Routes
```typescript
// ✅ Good - Use validateRequest middleware
import { validateRequest } from '../../shared/utils/validation.utils';
import { createUserSchema } from './user.schema';

router.post(
  '/',
  authMiddleware,
  validateRequest(createUserSchema),
  async (req, res, next) => {
    // req.body is now validated and typed
  }
);
```

---

## 🛣️ Route Definitions

### Standard Route Pattern
```typescript
/**
 * =============================================================================
 * MODULE NAME - ROUTES
 * =============================================================================
 * 
 * Brief description of what this module handles.
 * 
 * Endpoints:
 * METHOD /endpoint - Description
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateRequest } from '../../shared/utils/validation.utils';
import { myService } from './my.service';
import { mySchema } from './my.schema';

const router = Router();

/**
 * @route   METHOD /api/v1/module/endpoint
 * @desc    What this endpoint does
 * @access  Public | Private | Role-specific
 */
router.method(
  '/endpoint',
  authMiddleware,                    // If protected
  roleGuard(['customer']),           // If role-specific
  validateRequest(mySchema),         // If has body/query
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await myService.doSomething(req.body);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as myRouter };
```

---

## 📤 Response Format

### Success Response
```typescript
// ✅ Standard success response
res.json({
  success: true,
  data: { ... }
});

// ✅ With message
res.json({
  success: true,
  message: 'Profile updated successfully',
  data: { ... }
});

// ✅ Paginated response
res.json({
  success: true,
  data: {
    items: [...],
    pagination: {
      total: 100,
      limit: 20,
      offset: 0,
      hasMore: true
    }
  }
});
```

### Status Codes
```typescript
res.status(200) // OK - GET, PUT success
res.status(201) // Created - POST success
res.status(204) // No Content - DELETE success
res.status(400) // Bad Request - Validation error
res.status(401) // Unauthorized - Not authenticated
res.status(403) // Forbidden - Not authorized
res.status(404) // Not Found
res.status(409) // Conflict - Duplicate
res.status(429) // Too Many Requests
res.status(500) // Internal Server Error
```

---

## 🔧 Service Layer

### Service Class Pattern
```typescript
/**
 * =============================================================================
 * MODULE NAME - SERVICE
 * =============================================================================
 * 
 * Business logic for [module description].
 * =============================================================================
 */

import { db } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { CreateSomethingInput } from './my.schema';

class MyService {
  /**
   * Create a new something
   */
  async create(userId: string, data: CreateSomethingInput): Promise<SomethingRecord> {
    // 1. Validate business rules
    const existing = db.getSomethingByUserId(userId);
    if (existing) {
      throw new AppError(409, 'ALREADY_EXISTS', 'Record already exists');
    }

    // 2. Perform operation
    const record = db.createSomething({
      userId,
      ...data,
      createdAt: new Date().toISOString()
    });

    // 3. Log important actions
    logger.info(`Created something for user ${userId}`);

    // 4. Return result
    return record;
  }
}

// Export singleton instance
export const myService = new MyService();
```

---

## 🧪 Testing Guidelines

### Test File Naming
```
src/modules/auth/
├── auth.service.ts
├── auth.service.test.ts    # Unit tests
└── auth.routes.test.ts     # Integration tests
```

### Test Structure
```typescript
describe('AuthService', () => {
  describe('sendOtp', () => {
    it('should generate and store OTP', async () => {
      // Arrange
      const phone = '+919876543210';
      const role = 'customer';

      // Act
      const result = await authService.sendOtp(phone, role);

      // Assert
      expect(result.expiresIn).toBe(300);
      expect(result.message).toContain(phone);
    });

    it('should throw error for invalid phone', async () => {
      // Arrange & Act & Assert
      await expect(authService.sendOtp('invalid', 'customer'))
        .rejects.toThrow('Invalid phone');
    });
  });
});
```

---

## ✅ Checklist for New Modules

- [ ] Create folder: `src/modules/{module-name}/`
- [ ] Create `index.ts` with exports
- [ ] Create `{module}.routes.ts` with JSDoc comments
- [ ] Create `{module}.service.ts` with business logic
- [ ] Create `{module}.schema.ts` with Zod schemas
- [ ] Register routes in `server.ts`
- [ ] Add endpoint documentation to `API_CONTRACTS.md`
- [ ] Add unit tests for service
- [ ] Add integration tests for routes

---

## 🚫 Don'ts

1. **Don't** put business logic in routes - use services
2. **Don't** use `any` type - define proper types
3. **Don't** skip validation - always use schemas
4. **Don't** log sensitive data (passwords, tokens)
5. **Don't** catch errors without handling them
6. **Don't** hardcode values - use config/environment
7. **Don't** mix concerns - keep modules focused

---

## ✨ Do's

1. **Do** use TypeScript strict mode
2. **Do** validate all inputs with Zod
3. **Do** use async/await (not callbacks)
4. **Do** document public functions with JSDoc
5. **Do** handle errors appropriately
6. **Do** use meaningful variable names
7. **Do** keep functions small and focused
8. **Do** write tests for critical paths
