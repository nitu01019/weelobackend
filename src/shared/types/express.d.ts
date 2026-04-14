/**
 * =============================================================================
 * EXPRESS TYPE AUGMENTATION
 * =============================================================================
 *
 * Extends the Express.Request interface globally so `req.user` is typed
 * throughout the codebase without per-file casts.
 *
 * NOTE: The same augmentation exists in auth.middleware.ts.  TypeScript merges
 * all `declare global { namespace Express { ... } }` blocks, so they are
 * additive. This file adds `transporterId` which auth.middleware.ts omits.
 * =============================================================================
 */

declare global {
  namespace Express {
    interface User {
      userId: string;
      role: string;
      phone: string;
      name?: string;
      transporterId?: string;
    }
    interface Request {
      user?: User;
    }
  }
}

export {};
