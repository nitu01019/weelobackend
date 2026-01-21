/**
 * =============================================================================
 * CORE MODULE - Central Exports
 * =============================================================================
 * 
 * Single entry point for all core functionality.
 * 
 * USAGE:
 * ```typescript
 * import { 
 *   UserRole, 
 *   BookingStatus, 
 *   AppError, 
 *   NotFoundError,
 *   ApiResponse 
 * } from '@core';
 * ```
 * 
 * =============================================================================
 */

// Constants & Enums
export * from './constants';

// Error Classes
export * from './errors/AppError';

// Response Builders
export * from './responses/ApiResponse';

// Environment Validation
export * from './config/env.validation';
