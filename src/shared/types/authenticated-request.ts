/**
 * =============================================================================
 * AUTHENTICATED REQUEST TYPES
 * =============================================================================
 *
 * Request types for routes that sit behind auth middleware.
 * `AuthenticatedRequest` guarantees `req.user` is present (non-optional).
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Request guaranteed to have user (passed auth middleware).
 */
export interface AuthenticatedRequest extends Request {
  user: Express.User;
}

export interface AuthenticatedRequestWithBody<T> extends AuthenticatedRequest {
  body: T;
}

export type AuthHandler = (
  req: AuthenticatedRequest,
  res: Response,
  next?: NextFunction,
) => Promise<void> | void;
