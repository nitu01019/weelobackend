/**
 * =============================================================================
 * NOTIFICATION MODULE - ROUTES
 * =============================================================================
 *
 * Handles FCM token registration and notification preferences.
 *
 * ENDPOINTS:
 * - POST /api/v1/notifications/register-token - Register FCM token
 * - DELETE /api/v1/notifications/unregister-token - Remove FCM token
 * - GET /api/v1/notifications/preferences - Get notification preferences
 * - PUT /api/v1/notifications/preferences - Update notification preferences
 *
 * FOR BACKEND DEVELOPERS:
 * - Tokens are stored in memory (use Redis/DB in production)
 * - Call register-token after login and on token refresh
 * =============================================================================
 */
export declare const notificationRouter: import("express-serve-static-core").Router;
//# sourceMappingURL=notification.routes.d.ts.map